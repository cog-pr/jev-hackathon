// 自然文から日付・時刻・所要時間の「候補」を抽出するための、決定的なコード処理。
// ここでは値の推測や生成は一切行わない。Jevが行うのは、ここで見つけた候補の中から
// 締切・所要時間として最も適切なものを選ぶことだけ（server.mjs 側の Choice 質問）。

const WEEKDAY_INDEX = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };

const pad2 = (n) => String(n).padStart(2, "0");

// datetime-local の value 形式（秒・タイムゾーンなし）に合わせる。
const toDateTimeLocal = (d) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

const dateOnly = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

// 過去の日付になってしまう月日・スラッシュ日付は、来年のことだとみなす。
const rollYearIfPast = (candidate, now) => {
  const today = dateOnly(now);
  if (candidate < today) {
    return new Date(candidate.getFullYear() + 1, candidate.getMonth(), candidate.getDate());
  }
  return candidate;
};

// 「今日を含めて、次に来るその曜日」。来週指定ならさらに7日後。
const resolveWeekday = (now, targetDow, isNextWeek) => {
  const today = dateOnly(now);
  let diff = (targetDow - today.getDay() + 7) % 7;
  if (isNextWeek) diff += 7;
  const d = new Date(today);
  d.setDate(today.getDate() + diff);
  return d;
};

function findDateSpans(text, now) {
  const spans = [];

  for (const m of text.matchAll(/明後日/g)) {
    const d = dateOnly(now);
    d.setDate(d.getDate() + 2);
    spans.push({ start: m.index, end: m.index + m[0].length, date: d });
  }
  for (const m of text.matchAll(/明日/g)) {
    const d = dateOnly(now);
    d.setDate(d.getDate() + 1);
    spans.push({ start: m.index, end: m.index + m[0].length, date: d });
  }
  for (const m of text.matchAll(/今日/g)) {
    spans.push({ start: m.index, end: m.index + m[0].length, date: dateOnly(now) });
  }
  for (const m of text.matchAll(/(来週)?(日|月|火|水|木|金|土)曜日?/g)) {
    const d = resolveWeekday(now, WEEKDAY_INDEX[m[2]], Boolean(m[1]));
    spans.push({ start: m.index, end: m.index + m[0].length, date: d });
  }
  for (const m of text.matchAll(/(\d{1,2})月(\d{1,2})日/g)) {
    const raw = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    spans.push({ start: m.index, end: m.index + m[0].length, date: rollYearIfPast(raw, now) });
  }
  for (const m of text.matchAll(/(\d{1,2})\/(\d{1,2})(?!\d)/g)) {
    const raw = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    spans.push({ start: m.index, end: m.index + m[0].length, date: rollYearIfPast(raw, now) });
  }

  // 開始位置が同じ場合は、より長く一致したもの（例：明後日 が 明日 より優先）を残す。
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const deduped = [];
  for (const span of spans) {
    if (deduped.some((s) => span.start < s.end && span.end > s.start)) continue;
    deduped.push(span);
  }
  return deduped;
}

function findTimeSpans(text) {
  const spans = [];
  for (const m of text.matchAll(/(\d{1,2}):(\d{2})/g)) {
    spans.push({ start: m.index, end: m.index + m[0].length, hours: Number(m[1]), minutes: Number(m[2]) });
  }
  // 「時間」（所要時間の単位）を時刻の「時」と誤認しないよう、直後が「間」なら除外する。
  for (const m of text.matchAll(/(\d{1,2})時(?!間)(半|(\d{1,2})分)?/g)) {
    const start = m.index;
    const end = start + m[0].length;
    if (spans.some((s) => start < s.end && end > s.start)) continue; // コロン表記とのみ重複を避ける
    const minutes = m[2] === "半" ? 30 : m[3] ? Number(m[3]) : 0;
    spans.push({ start, end, hours: Number(m[1]), minutes });
  }
  spans.sort((a, b) => a.start - b.start);
  return spans;
}

// 日付表現の直後、この文字数以内にある時刻表現は同じ締切の一部とみなす（例：「9/25 18:00」）。
const TIME_PROXIMITY = 6;

/**
 * 締切候補を抽出する。時刻の指定がない日付には、その日の終わり(23:59)を仮の時刻として補う
 * （日付だけを候補として渡すと Jev が選びにくく、正規化後の値も曖昧になるため）。
 * この「時刻なし→23:59」という補完は確認カードで必ず編集可能にする。
 */
export function extractDeadlineCandidates(text, now, maxCandidates) {
  const dateSpans = findDateSpans(text, now);
  const timeSpans = findTimeSpans(text);
  const usedTime = new Set();
  const results = [];

  for (const d of dateSpans) {
    const timeIndex = timeSpans.findIndex(
      (t, i) => !usedTime.has(i) && t.start >= d.end && t.start - d.end <= TIME_PROXIMITY,
    );
    let end = d.end;
    let hours = 23;
    let minutes = 59;
    if (timeIndex !== -1) {
      const t = timeSpans[timeIndex];
      usedTime.add(timeIndex);
      end = t.end;
      hours = t.hours;
      minutes = t.minutes;
    }
    const iso = new Date(d.date.getFullYear(), d.date.getMonth(), d.date.getDate(), hours, minutes);
    results.push({ text: text.slice(d.start, end).trim(), iso: toDateTimeLocal(iso), start: d.start });
  }

  // 日付表現が文中に一つもないときだけ、単独の時刻表現を「今日のその時刻」として拾う。
  if (dateSpans.length === 0) {
    timeSpans.forEach((t, i) => {
      if (usedTime.has(i)) return;
      const today = dateOnly(now);
      const iso = new Date(today.getFullYear(), today.getMonth(), today.getDate(), t.hours, t.minutes);
      results.push({ text: text.slice(t.start, t.end).trim(), iso: toDateTimeLocal(iso), start: t.start });
    });
  }

  results.sort((a, b) => a.start - b.start);
  const truncated = results.length > maxCandidates;
  return {
    candidates: results.slice(0, maxCandidates).map(({ text, iso }) => ({ text, iso })),
    truncated,
  };
}

const DURATION_SUFFIX = /^(くらい|ぐらい|程度|ほど|以内)?/;

function extendWithSuffix(text, end) {
  const suffix = DURATION_SUFFIX.exec(text.slice(end))?.[0] ?? "";
  return end + suffix.length;
}

/**
 * 所要時間候補を抽出する。「1〜2時間」のような幅表現は、MVPでは単一の estimatedMinutes
 * しか扱えないため、安全側（上限値）を採用する（1〜2時間 → 120分）。元の表現は
 * candidate.text にそのまま残るため、確認カードで原文を確認できる。
 */
export function extractDurationCandidates(text, maxCandidates) {
  const consumed = [];
  const results = [];
  const isFree = (start, end) => consumed.every((c) => end <= c.start || start >= c.end);
  const mark = (start, end) => consumed.push({ start, end });

  const patterns = [
    { re: /(\d{1,2})\s*[〜~\-−ー]\s*(\d{1,2})\s*時間/g, minutes: (m) => Number(m[2]) * 60 },
    { re: /(\d{1,3})\s*[〜~\-−ー]\s*(\d{1,3})\s*分/g, minutes: (m) => Number(m[2]) },
    { re: /(\d{1,2})時間半/g, minutes: (m) => Number(m[1]) * 60 + 30 },
    { re: /(\d{1,2})時間/g, minutes: (m) => Number(m[1]) * 60 },
    { re: /(\d{1,3})分/g, minutes: (m) => Number(m[1]) },
  ];

  for (const { re, minutes } of patterns) {
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (!isFree(start, end)) continue;
      mark(start, end);
      const shown = extendWithSuffix(text, end);
      results.push({ text: text.slice(start, shown).trim(), minutes: minutes(m), start });
    }
  }

  results.sort((a, b) => a.start - b.start);
  const truncated = results.length > maxCandidates;
  return {
    candidates: results.slice(0, maxCandidates).map(({ text, minutes }) => ({ text, minutes })),
    truncated,
  };
}

const MAX_TITLE_LENGTH = 40;

/**
 * タイトルは生成せず、決定的なヒューリスティックだけで決める。
 * 最初の非空行を基本候補とし、句読点があればその最初の文に絞り、
 * それでも長すぎる場合だけ末尾を省略する。確認カードで必ず編集可能にする。
 */
export function extractTitle(text) {
  const trimmed = text.trim();
  if (!trimmed) return "名称未設定のタスク";

  const firstLine = trimmed.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? trimmed;
  const sentenceMatch = firstLine.match(/^[^。.!?！？]+[。.!?！？]?/);
  let candidate = (sentenceMatch ? sentenceMatch[0] : firstLine).replace(/[。.!?！？]$/, "").trim();
  if (!candidate) candidate = firstLine;
  if (candidate.length > MAX_TITLE_LENGTH) {
    candidate = `${candidate.slice(0, MAX_TITLE_LENGTH - 1)}…`;
  }
  return candidate || "名称未設定のタスク";
}
