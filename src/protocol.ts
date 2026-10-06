// Bun 側とページ側ランタイムの両方から使う、JSON でやり取りする型。

export type TextMatch =
  | { kind: "string"; value: string; exact?: boolean }
  | { kind: "regex"; source: string; flags: string };

export type Step =
  | { type: "css"; selector: string }
  | {
      type: "role";
      role: string;
      name?: TextMatch;
      level?: number;
      includeHidden?: boolean;
    }
  | { type: "text"; text: TextMatch }
  | { type: "testId"; id: string }
  | { type: "label"; text: TextMatch }
  | { type: "placeholder"; text: TextMatch }
  | { type: "altText"; text: TextMatch }
  | { type: "title"; text: TextMatch }
  | { type: "nth"; index: number }
  | { type: "filter"; hasText?: TextMatch; hasNotText?: TextMatch; has?: Step[]; hasNot?: Step[] };

export interface ElementState {
  tag: string;
  preview: string;
  visible: boolean;
  text: string;
  value: string | string[] | null;
  checked: boolean | "mixed" | null;
  disabled: boolean;
  focused: boolean;
  attributes: Record<string, string>;
  classes: string[];
  role: string | null;
  name: string;
  styles: Record<string, string>;
}

export interface InspectResult {
  count: number;
  previews: string[];
  element: ElementState | null;
}

export type MarkResult =
  | { count: 1; selector: string; token: string }
  | { count: number; previews: string[] };

export interface PageError {
  message: string;
  stack?: string;
}
