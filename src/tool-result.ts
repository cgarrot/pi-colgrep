/**
 * Helpers to create AgentToolResult-compatible objects.
 *
 * Pi's AgentToolResult expects `content` as an array of TextContent objects
 * and a `details` field. These helpers wrap a plain string into that shape.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";

interface ToolResult<TDetails = undefined> {
  content: { type: "text"; text: string }[];
  details: TDetails;
  isError: boolean;
}

export function ok<TDetails = undefined>(
  text: string,
  details?: TDetails,
): ToolResult<TDetails> {
  return {
    content: [{ type: "text", text }],
    details: details as TDetails,
    isError: false,
  };
}

export function err(text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
    details: undefined,
    isError: true,
  };
}

/** Max result lines shown in the collapsed view before "… +N more". */
export const COLLAPSED_PREVIEW_LINES = 3;

/**
 * Render a collapsed-view preview: up to `COLLAPSED_PREVIEW_LINES` result
 * lines, a "+N more" marker when truncated, and an expand hint.
 *
 * Lets the operator see what the tool actually returned without expanding
 * every call, while the full output still lives behind `ctrl+o`.
 */
export function previewBlock(lines: string[], theme: Theme): string {
  const preview = lines.slice(0, COLLAPSED_PREVIEW_LINES);
  const remaining = lines.length - preview.length;

  let text = preview
    .map((line) => `\n${theme.fg("toolOutput", `  ${line}`)}`)
    .join("");
  if (remaining > 0) {
    text += `\n${theme.fg("muted", `  … +${remaining} more`)}`;
  }
  text += `\n${theme.fg("muted", "  (ctrl+o to expand)")}`;
  return text;
}
