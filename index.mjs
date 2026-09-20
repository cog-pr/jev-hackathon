// Jev API (TypeSafe System One) の疎通確認用の最小サンプル。
// 実行方法: npm install && npm start
import { noul, TypeSafeClient } from "@typesafe-ai/sdk";

if (!process.env.TYPESAFE_API_KEY) {
  console.error("TYPESAFE_API_KEY が設定されていません。.env を確認してください。");
  process.exit(1);
}

const client = new TypeSafeClient();

try {
  const response = await client.systemOne({
    state: { message: "Jev API との接続テストです。" },
    questions: {
      isGreeting: noul("このメッセージは挨拶や導入の文章ですか？"),
    },
  });

  const answer = response.answers.isGreeting;
  console.log("Jev API 疎通確認: OK");
  console.log(`判定 (isGreeting): ${answer.noul >= 0.5 ? "Yes" : "No"} (noul=${answer.noul})`);
} catch (error) {
  console.error("Jev API 疎通確認: NG");
  console.error(error);
  process.exit(1);
}
