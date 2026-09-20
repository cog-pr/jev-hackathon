// 「今、何から手をつけるべきか」を Jev に判定させるサーバー。
// APIキーはこのプロセス内だけで使い、ブラウザには渡さない。
import express from "express";
import { score, TypeSafeClient } from "@typesafe-ai/sdk";

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

async function judgeTask(task, currentContext) {
  const { answers } = await client.systemOne({
    state: { currentContext, task },
    questions: { priority: priorityQuestion },
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
  };
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

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
