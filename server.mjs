// 「今、何から手をつけるべきか」を Jev に判定させるサーバー。
// APIキーはこのプロセス内だけで使い、ブラウザには渡さない。
import express from "express";
import { choice, score, TypeSafeClient } from "@typesafe-ai/sdk";
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
const DRIVER_CRITERIA = {
  deadline: "締切が近く、時間的にこれ以上後回しにしにくい",
  importance: "成績・評価・仕事など、結果への影響が大きい",
  time_fit: "今の空き時間や次の予定までの時間に、この作業が収まりやすい",
  context_fit: "今いる場所・使える端末・集中状態が、この作業に向いている",
  none: "今このタスクを優先すべき強い理由は見当たらない",
};

// なぜ今このタスクに取り組みにくいのか。こちらもランキングには使わない。
const BLOCKER_CRITERIA = {
  time: "使える時間が短く、この作業を進めるには足りない",
  device: "この作業に必要なPCや端末・道具が、今は使えない",
  focus: "この作業に必要な集中力を、今は確保しにくい",
  location: "今いる場所が、この作業をするのに向いていない",
  not_yet: "着手を妨げる事情はないが、締切まで余裕があり今やる必要性が低い",
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

const blockerQuestion = choice(
  {
    judgment:
      "`currentContext` の状況にいるユーザーが今この `task` に着手しにくいとしたら、その最大の要因は何か",
    exclusion: "タスク自体の難しさではなく、今この状況だからこそ生じている要因を1つだけ選ぶ",
  },
  BLOCKER_CRITERIA,
);

async function judgeTask(task, currentContext) {
  // 3つの質問は互いに独立しているため、同じ状態に対して1回の呼び出しでまとめて尋ねる。
  const { answers } = await client.systemOne({
    state: { currentContext, task },
    questions: { priority: priorityQuestion, driver: driverQuestion, blocker: blockerQuestion },
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
    // 説明用。並び順の計算には使わない。
    driver: { key: answers.driver.choice, confidence: answers.driver.confidence },
    blocker: { key: answers.blocker.choice, confidence: answers.blocker.confidence },
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
