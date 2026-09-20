// 「今、何から手をつけるべきか」を Jev に判定させるサーバー。
// APIキーはこのプロセス内だけで使い、ブラウザには渡さない。
import express from "express";
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { extractDeadlineCandidates, extractDurationCandidates, extractTitle, toLocalISO } from "./taskParser.mjs";

if (!process.env.TYPESAFE_API_KEY) {
  console.error("TYPESAFE_API_KEY が設定されていません。.env を確認してください。");
  process.exit(1);
}

const client = new TypeSafeClient();

const PRIORITY_LEVELS = [
  "今は取り組む必要がなく、後回しにしても問題ない",
  "余裕があれば着手してもよいが、今すぐでなくてよい",
  "早めに着手すべきだが、今すぐでなくてもよい",
  "緊急性・重要性が高く、今すぐ最優先で取り組むべき",
];

// このレベル以上を「今からやる」として表示する。
const NOW_THRESHOLD = 2;

const priorityQuestion = score(
  {
    judgment:
      "`currentContext` の状況にいるユーザーが、今この `task` にどれくらい優先して取り組むべきか",
    considerations: [
      "`currentContext.currentTime` から `task.deadline` までの残り時間と `task.estimatedMinutes` を比べたときの、締切の切迫度",
      "`task.note` や `task.detail` から読み取れる、このタスクの重要性や後回しにしたときの影響",
      "`currentContext.availableMinutes` `currentContext.focus` `currentContext.location` `currentContext.hasPC` を踏まえて、今この場でこのタスクを実際に進められるか",
      "締切が近く重要なタスクでも、今の場所・残り時間・道具では着手できない場合は優先度を下げる",
      "重要度が低くても、今の状況でこそ片付けられるタスクは優先度を上げる",
      "`currentContext.nextEvent` がある場合、その予定が始まるまでに区切りがつくかどうか。中断したくない作業は、まとまった時間が取れるときに回す",
      "`currentContext.currentEvent` がある場合、ユーザーは今その予定の最中であり、基本的に別の作業に着手できない",
    ],
  },
  PRIORITY_LEVELS,
);

// なぜ今このタスクを優先するのか。ランキングには一切使わず、説明のためだけに使う。
// time_fit / context_fit には、blocker 側の time / device / focus / location と
// 同時に成立しないよう対比を書いておく（コードでの後処理はしない）。
const DRIVER_CRITERIA = {
  deadline: "締切が近く、時間的にこれ以上後回しにしにくい",
  importance: "成績・評価・仕事など、結果への影響が大きい",
  time_fit:
    "`task.estimatedMinutes` が `currentContext.availableMinutes` に収まり、今の空き時間で区切りのつくところまで進められる。時間が足りない場合はこれを選ばない",
  context_fit:
    "今いる場所・使える端末・集中状態が、この作業に向いている。場所・端末・集中状態のいずれかがこの作業を妨げている場合はこれを選ばない",
  none: "今このタスクを優先すべき強い理由は見当たらない",
};

// 妨げの「種類」だけを答える投機的な質問。妨げの有無は hasBlocker（Noul）で別に判定する。
const BLOCKER_KIND_CRITERIA = {
  time: "`task.estimatedMinutes` が `currentContext.availableMinutes` を明らかに超えており、今の時間では区切りのつくところまで進められない。収まっている場合、または所要時間が不明で長時間かかるとは言えない場合は選ばない",
  device:
    "`currentContext.hasPC` が false であり、かつ `task` の内容がPCなどの端末を実際に必要とする作業である。端末がないだけで、この作業に端末が要らないなら選ばない",
  focus:
    "`currentContext.focus` が低く、かつ `task` がまとまった集中を必要とする作業である。どちらか一方だけでは選ばない",
  location:
    "`currentContext.location` が、この `task` を行える場所ではない。その場所でも作業自体はできるなら選ばない",
  none: "今の状況で、この作業に取りかかるのを妨げるものは特にない",
};

const driverQuestion = choice(
  {
    judgment:
      "`currentContext` の状況にいるユーザーが今この `task` に取り組むとしたら、その最大の理由は何か",
    exclusion: "優先すべきかどうかの判断ではなく、最も当てはまる理由を1つだけ選ぶ",
  },
  DRIVER_CRITERIA,
);

// 妨げが「あるかどうか」の判定。Choiceは必ず1つ選ぶため、有無はNoulで別に尋ねる。
const hasBlockerQuestion = noul(
  {
    judgment: "`currentContext` の状況では、ユーザーが今この `task` を進めるのが難しいか",
    exclusion:
      "優先度が高いかどうかは問わない。締切まで余裕があることは妨げではない。状態に根拠がない要因を推測しない",
  },
  {
    true: "今の時間・場所・端末・集中状態のいずれかが原因で、この作業を今は進めにくい。時間が足りず区切りのつくところまで進められない場合も含む",
    false: "今の状況でも、この作業を支障なく進められる",
  },
);

const blockerKindQuestion = choice(
  {
    judgment: "仮にこの `task` への着手を妨げる要因があるとすれば、最も当てはまるのはどれか",
    premise: "妨げの有無そのものは別の質問で判定される。ここでは妨げがある場合を想定して種類だけを選ぶ",
    exclusion:
      "`currentContext` や `task` に根拠が書かれていない要因を推測で選ばない。判断がつかない場合は none を選ぶ",
  },
  BLOCKER_KIND_CRITERIA,
);

async function judgeTask(task, currentContext) {
  // 4つの質問は互いに独立しているため、同じ状態に対して1回の呼び出しでまとめて尋ねる。
  // HTTPリクエストはタスク1件につき1回のまま。
  const { answers } = await client.systemOne({
    state: { currentContext, task },
    questions: {
      priority: priorityQuestion,
      driver: driverQuestion,
      hasBlocker: hasBlockerQuestion,
      blockerKind: blockerKindQuestion,
    },
  });

  const { score: value, confidence, legend } = answers.priority;
  const level = Math.round(value);

  return {
    task,
    score: value,
    confidence,
    level,
    levelLabel: legend[level],
    shouldDoNow: value >= NOW_THRESHOLD,
    // 以下はすべて説明用。並び順の計算には一切使わない。
    driver: { key: answers.driver.choice, confidence: answers.driver.confidence },
    blocker: {
      presence: answers.hasBlocker.noul,
      key: answers.blockerKind.choice,
      confidence: answers.blockerKind.confidence,
    },
  };
}

// 自然文タスク入力の上限。極端に長い文章や候補過多で処理が肥大化しないようにする。
const MAX_TASK_TEXT_LENGTH = 500;
const MAX_DEADLINE_CANDIDATES = 6;
const MAX_DURATION_CANDIDATES = 4;

/**
 * 貼り付けられた自然文から Task を構造化する。
 *
 * ここでの Jev の役割は「コードが見つけた候補の中から選ぶ」ことだけであり、
 * 文中に存在しない日付・時間を作文することはできない（Choiceは候補にない値を返せない）。
 * タイトルと補足は決定的なコード処理のみで決め、Jevには渡さない。
 */
async function parseTaskText(text, now) {
  const deadlineExtraction = extractDeadlineCandidates(text, now, MAX_DEADLINE_CANDIDATES);
  const durationExtraction = extractDurationCandidates(text, MAX_DURATION_CANDIDATES);

  // 締切・所要時間は別フィールドになるため、その原文スパンはタイトルから取り除く。
  const title = extractTitle(text, [
    ...deadlineExtraction.candidates.map((c) => c.text),
    ...durationExtraction.candidates.map((c) => c.text),
  ]);

  const questions = {};
  if (deadlineExtraction.candidates.length > 0) {
    const criteria = { none: "文章中に締切の記載がない、またはどの候補も締切を表していない" };
    deadlineExtraction.candidates.forEach((c, i) => {
      criteria[`d${i}`] = c.text;
    });
    questions.deadline = choice(
      "`rawText` の中で、これを提出・完了しなければならない締切を表しているのはどれですか。`now` を基準に、配布日・実施日など締切以外の日付とは区別してください。",
      criteria,
    );
  }
  if (durationExtraction.candidates.length > 0) {
    const criteria = { none: "所要時間の記載がない、またはどの候補も所要時間を表していない" };
    durationExtraction.candidates.forEach((c, i) => {
      criteria[`u${i}`] = c.text;
    });
    questions.duration = choice(
      "`rawText` の中で、この作業にかかる時間の見積もりを表しているのはどれですか。",
      criteria,
    );
  }

  const result = {
    title,
    deadline: null,
    estimatedMinutes: null,
    note: text,
    deadlineSource: null,
    durationSource: null,
    confidence: { deadline: null, duration: null },
    truncated: { deadline: deadlineExtraction.truncated, duration: durationExtraction.truncated },
  };

  if (Object.keys(questions).length === 0) {
    return result; // 候補が一つもなければ Jev を呼ばない
  }

  const { answers } = await client.systemOne({
    state: { rawText: text, now: toLocalISO(now) },
    questions,
  });

  if (answers.deadline) {
    result.confidence.deadline = answers.deadline.confidence;
    if (answers.deadline.choice !== "none") {
      const picked = deadlineExtraction.candidates[Number(answers.deadline.choice.slice(1))];
      result.deadline = picked.iso;
      result.deadlineSource = picked.text;
    }
  }
  if (answers.duration) {
    result.confidence.duration = answers.duration.confidence;
    if (answers.duration.choice !== "none") {
      const picked = durationExtraction.candidates[Number(answers.duration.choice.slice(1))];
      result.estimatedMinutes = picked.minutes;
      result.durationSource = picked.text;
    }
  }

  return result;
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

app.post("/api/parse-task", async (req, res) => {
  const raw = req.body?.text;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    res.status(400).json({ error: "テキストを入力してください。" });
    return;
  }

  const text = raw.trim();
  if (text.length > MAX_TASK_TEXT_LENGTH) {
    res.status(400).json({
      error: `文章が長すぎます（${MAX_TASK_TEXT_LENGTH}文字以内にしてください）。複数の課題が含まれている場合は、1つずつに分けて貼り付けてください。`,
    });
    return;
  }

  try {
    const result = await parseTaskText(text, new Date());
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: "Jev API の呼び出しに失敗しました。" });
  }
});

app.post("/api/rank", async (req, res) => {
  const { context, tasks } = req.body ?? {};

  if (!Array.isArray(tasks) || tasks.length === 0) {
    res.status(400).json({ error: "タスクが登録されていません。" });
    return;
  }

  try {
    const results = await Promise.all(tasks.map((task) => judgeTask(task, context)));
    results.sort((a, b) => b.score - a.score);
    res.json({ results, levels: PRIORITY_LEVELS, scoreMax: PRIORITY_LEVELS.length - 1 });
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: "Jev API の呼び出しに失敗しました。" });
  }
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`http://localhost:${port} で起動しました`);
});
