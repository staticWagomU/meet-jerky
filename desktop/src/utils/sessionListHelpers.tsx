import { type ReactNode } from "react";
import type { SessionSummary } from "../hooks/useSessionList";
import {
  OTHER_TRACK_DEVICE_LABEL,
  SELF_TRACK_DEVICE_LABEL,
} from "./audioTrackLabels";
import {
  getCompactSessionTitle,
  getFileName,
  SESSION_DATETIME_UNKNOWN_LABEL,
} from "./transcriptViewFormatters";

export const SEARCH_QUERY_LABEL_MAX_LENGTH = 40;
export const SEARCH_EXCERPT_CONTEXT_LENGTH = 42;

export interface TranscriptTrackCounts {
  self: number;
  other: number;
  unknown: number;
}

export interface SessionStartedAtDisplay {
  label: string;
  iso: string | null;
}

export function getSessionStartedAtDisplay(
  startedAtSecs: number,
): SessionStartedAtDisplay {
  const startedAtMs = startedAtSecs * 1000;
  if (!Number.isFinite(startedAtMs)) {
    return { label: SESSION_DATETIME_UNKNOWN_LABEL, iso: null };
  }
  const startedAtDate = new Date(startedAtMs);
  if (Number.isNaN(startedAtDate.getTime())) {
    return { label: SESSION_DATETIME_UNKNOWN_LABEL, iso: null };
  }
  return {
    label: startedAtDate.toLocaleString(),
    iso: startedAtDate.toISOString(),
  };
}

export function formatSearchQueryForLabel(query: string): string {
  const normalized = query.split(/\s+/).filter(Boolean).join(" ");
  return normalized.length > SEARCH_QUERY_LABEL_MAX_LENGTH
    ? `${normalized.slice(0, SEARCH_QUERY_LABEL_MAX_LENGTH)}...`
    : normalized;
}

export function getSearchTerms(query: string): string[] {
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export function unescapeInlineMarkdownText(text: string): string {
  return text.replace(/\\([\\`*_[\]])/g, "$1");
}

export function formatSearchExcerptText(text: string): string {
  return unescapeInlineMarkdownText(text)
    .replace(/\*\*\[([^\]]+)\]\s*([^:*]+):\*\*/g, "[$1] $2:")
    .replace(/\s+/g, " ")
    .trim();
}

export function getSearchMatchExcerpt(
  text: string,
  query: string,
): string | null {
  const searchTerms = getSearchTerms(query);
  if (searchTerms.length === 0 || !text) {
    return null;
  }
  const searchText = unescapeInlineMarkdownText(text);
  const normalizedText = searchText.toLocaleLowerCase();
  const matchedTerm = searchTerms.find((term) => normalizedText.includes(term));
  if (!matchedTerm) {
    return null;
  }
  const matchIndex = normalizedText.indexOf(matchedTerm);
  if (matchIndex < 0) {
    return null;
  }
  const start = Math.max(0, matchIndex - SEARCH_EXCERPT_CONTEXT_LENGTH);
  const end = Math.min(
    searchText.length,
    matchIndex + matchedTerm.length + SEARCH_EXCERPT_CONTEXT_LENGTH,
  );
  const excerpt = formatSearchExcerptText(searchText.slice(start, end));
  if (!excerpt) {
    return null;
  }
  return `${start > 0 ? "..." : ""}${excerpt}${end < searchText.length ? "..." : ""}`;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function renderHighlightedSearchExcerpt(
  text: string,
  query: string,
): ReactNode {
  const searchTerms = Array.from(new Set(getSearchTerms(query)))
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (searchTerms.length === 0) {
    return text;
  }

  const matcher = new RegExp(`(${searchTerms.join("|")})`, "gi");
  const exactMatcher = new RegExp(`^(${searchTerms.join("|")})$`, "i");
  return text.split(matcher).map((part, index) =>
    exactMatcher.test(part) ? (
      <mark key={`${part}-${index}`}>{part}</mark>
    ) : (
      part
    ),
  );
}

export function hasTranscriptBody(searchText: string): boolean {
  return searchText.trim().length > 0;
}

export function getTranscriptTrackCounts(
  searchText: string,
): TranscriptTrackCounts {
  const counts = { self: 0, other: 0, unknown: 0 };
  for (const match of searchText.matchAll(/\*\*\[[^\]]+\]\s*([^:*]+):\*\*/g)) {
    const speaker = match[1]?.trim();
    if (speaker === "自分") {
      counts.self += 1;
    } else if (speaker === "相手側") {
      counts.other += 1;
    } else if (speaker) {
      counts.unknown += 1;
    }
  }
  return counts;
}

function getTranscriptTrackSearchLabels(
  counts: TranscriptTrackCounts,
): string[] {
  return [
    ...(counts.self > 0 ? ["自分", SELF_TRACK_DEVICE_LABEL] : []),
    ...(counts.other > 0 ? ["相手側", OTHER_TRACK_DEVICE_LABEL] : []),
    ...(counts.unknown > 0 ? ["音声ソース不明"] : []),
  ];
}

export function sessionMatchesQuery(
  session: SessionSummary,
  startedAtLabel: string,
  query: string,
): boolean {
  const searchTerms = getSearchTerms(query);
  if (searchTerms.length === 0) {
    return true;
  }
  const searchableText = [
    getCompactSessionTitle(session.title),
    getFileName(session.path),
    startedAtLabel,
    ...getTranscriptTrackSearchLabels(
      getTranscriptTrackCounts(session.searchText),
    ),
    unescapeInlineMarkdownText(session.searchText),
  ]
    .join(" ")
    .toLocaleLowerCase();
  return searchTerms.every((term) => searchableText.includes(term));
}
