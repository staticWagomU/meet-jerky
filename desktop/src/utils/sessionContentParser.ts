/**
 * 保存済みセッション Markdown の文字起こしを録音詳細で扱える
 * 構造化データに変換する。フォーマットの仕様:
 *   - 1行目: `# {title} - YYYY-MM-DD HH:MM`
 *   - 発話行: `**[HH:MM:SS] {speaker}:** {text}`
 *
 * 仕様外の行は `notes` として落とし、UI ではタイムラインに混ぜずに別欄で出す。
 */

const SEGMENT_LINE_REGEX = /^\*\*\[(\d{1,2}:\d{2}:\d{2})\] ([^:]+):\*\*\s*(.*)$/;

export interface ParsedSessionSegment {
  time: string;
  speaker: string;
  text: string;
}

export interface ParsedSessionContent {
  titleLine: string;
  segments: ParsedSessionSegment[];
  notes: string[];
}

export function parseSessionMarkdown(body: string): ParsedSessionContent {
  const lines = body.split(/\r?\n/);
  let titleLine = "";
  const segments: ParsedSessionSegment[] = [];
  const notes: string[] = [];

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) {
      continue;
    }
    if (!titleLine && line.startsWith("# ")) {
      titleLine = line.replace(/^#\s+/, "");
      continue;
    }
    const match = SEGMENT_LINE_REGEX.exec(line);
    if (match) {
      segments.push({
        time: match[1],
        speaker: match[2].trim(),
        text: unescapeInlineMarkdown(match[3]),
      });
      continue;
    }
    notes.push(line);
  }

  return { titleLine, segments, notes };
}

function unescapeInlineMarkdown(value: string): string {
  return value.replace(/\\([\\`*_[\]])/g, "$1");
}
