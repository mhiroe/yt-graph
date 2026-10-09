// Wish-centered read use cases. Pure ranking only: persistence and CLI parsing stay in adapters.
// The result is evidence for human/adapter judgment, never an automatic merge or write decision.

import type { ComponentKind, ComponentStatus, Revision } from "./components.ts";
import type { ComponentId, RepositoryId } from "./ids.ts";
import type { RelationKey } from "./relations.ts";
import type { ListedComponent } from "./sql/store.ts";

export const WISH_QUERY_RESULT_SCHEMA = "wf4.wish-query-result.v1";
export const WISH_QUERY_TITLE_MAX = 240;
export const WISH_QUERY_TERM_MAX = 32;
export const WISH_QUERY_SCAN_MAX = 200;
export const WISH_QUERY_CANDIDATE_MAX = 25;

export type WishQueryReasonCode =
  | "exact_id"
  | "same_outcome"
  | "declared_relation"
  | "scope_match"
  | "no_match_within_bounds"
  | "truncated"
  | "stale_revision";

export type WishQueryCandidate = {
  readonly component_id: ComponentId;
  readonly kind: ComponentKind;
  readonly status?: ComponentStatus;
  readonly state_revision: Revision;
  readonly title?: string;
  readonly title_truncated: boolean;
  readonly locator?: string;
  readonly locator_truncated: boolean;
  /**
   * この component を roster に持つ最新 sprint の `sprint_id` (その effective
   * iteration の中で — `> sprint:` binding と同じ規則)。無ければ省略。
   */
  readonly sprint?: string;
  readonly updated_at: string;
  readonly score: number;
  readonly reason_codes: readonly WishQueryReasonCode[];
};

export type WishQueryDisposition =
  | "candidate_found"
  | "no_match_within_bounds"
  | "incomplete"
  | "stale_revision";

export type WishQueryResult = {
  readonly schema: typeof WISH_QUERY_RESULT_SCHEMA;
  readonly use_case: "preflight";
  readonly repository_id: RepositoryId;
  readonly proposed_title: string;
  readonly subject_component_id: ComponentId | null;
  readonly source_revision: Revision | null;
  readonly disposition: WishQueryDisposition;
  readonly reason_codes: readonly WishQueryReasonCode[];
  readonly candidates: readonly WishQueryCandidate[];
  readonly bounds: {
    readonly scanned: number;
    readonly scan_limit: number;
    readonly candidate_limit: number;
    readonly scan_truncated: boolean;
    readonly candidate_truncated: boolean;
  };
  readonly truncated: boolean;
  readonly complete: boolean;
  readonly persistent_delta_bytes: 0;
};

export type WishQueryInput = {
  readonly repository_id: RepositoryId;
  readonly proposed_title: string;
  readonly subject_component_id?: ComponentId;
  readonly subject_revision?: Revision;
  readonly expected_revision?: Revision;
  readonly components: readonly ListedComponent[];
  readonly outgoing_relations: readonly RelationKey[];
  /**
   * component_id -> effective sprint_id の写像 (dispatch が DB から組み立てる)。
   * 無ければ candidate は `sprint` field を持たない。
   */
  readonly sprint_bindings?: ReadonlyMap<ComponentId, string>;
  readonly scan_limit: number;
  readonly candidate_limit: number;
  readonly scan_truncated: boolean;
};

const REASON_ORDER: readonly WishQueryReasonCode[] = [
  "exact_id",
  "same_outcome",
  "declared_relation",
  "scope_match",
  "no_match_within_bounds",
  "truncated",
  "stale_revision",
];

function orderedReasons(reasons: Iterable<WishQueryReasonCode>): WishQueryReasonCode[] {
  const present = new Set(reasons);
  return REASON_ORDER.filter((reason) => present.has(reason));
}

export function normalizeWishQueryTitle(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
}

/** Latin-like words stay words; CJK chunks gain bigrams so related titles need not be identical. */
export function wishQueryTerms(value: string): readonly string[] {
  const normalized = normalizeWishQueryTitle(value);
  const chunks = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = new Set<string>();
  for (const chunk of chunks) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(chunk)) {
      const chars = Array.from(chunk);
      if (chars.length === 1) terms.add(chars[0] ?? "");
      for (let index = 0; index + 1 < chars.length; index += 1) {
        terms.add(`${chars[index]}${chars[index + 1]}`);
      }
    } else {
      terms.add(chunk);
    }
  }
  terms.delete("");
  return [...terms];
}

function bounded(value: string | undefined, max: number): {
  readonly value?: string;
  readonly truncated: boolean;
} {
  if (value === undefined) return { truncated: false };
  const chars = Array.from(value);
  if (chars.length <= max) return { value, truncated: false };
  return { value: chars.slice(0, max).join(""), truncated: true };
}

function overlapScore(query: readonly string[], candidate: readonly string[]): number {
  if (query.length === 0 || candidate.length === 0) return 0;
  const candidateSet = new Set(candidate.slice(0, WISH_QUERY_TERM_MAX));
  let shared = 0;
  for (const term of query) if (candidateSet.has(term)) shared += 1;
  return shared / query.length;
}

function compareCandidates(left: WishQueryCandidate, right: WishQueryCandidate): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.updated_at !== right.updated_at) return left.updated_at < right.updated_at ? 1 : -1;
  if (left.component_id === right.component_id) return 0;
  return left.component_id < right.component_id ? -1 : 1;
}

export function buildWishQueryResult(input: WishQueryInput): WishQueryResult {
  const subjectId = input.subject_component_id ?? null;
  const sourceRevision = input.subject_revision ?? null;
  if (
    input.expected_revision !== undefined && sourceRevision !== null &&
    input.expected_revision !== sourceRevision
  ) {
    return {
      schema: WISH_QUERY_RESULT_SCHEMA,
      use_case: "preflight",
      repository_id: input.repository_id,
      proposed_title: input.proposed_title,
      subject_component_id: subjectId,
      source_revision: sourceRevision,
      disposition: "stale_revision",
      reason_codes: ["stale_revision"],
      candidates: [],
      bounds: {
        scanned: 0,
        scan_limit: input.scan_limit,
        candidate_limit: input.candidate_limit,
        scan_truncated: false,
        candidate_truncated: false,
      },
      truncated: false,
      complete: false,
      persistent_delta_bytes: 0,
    };
  }

  const normalizedTitle = normalizeWishQueryTitle(input.proposed_title);
  const queryTerms = wishQueryTerms(input.proposed_title);
  const related = new Set(
    input.outgoing_relations
      .filter((relation) => relation.target.repository_id === input.repository_id)
      .map((relation) => relation.target.component_id),
  );
  const matches: WishQueryCandidate[] = [];
  for (const component of input.components) {
    if (component.component_id === subjectId) continue;
    const reasons = new Set<WishQueryReasonCode>();
    let score = 0;
    if (normalizedTitle === component.component_id.toLocaleLowerCase("en-US")) {
      reasons.add("exact_id");
      score = 1;
    }
    const candidateTitle = component.title_projection;
    if (candidateTitle !== undefined) {
      const normalizedCandidate = normalizeWishQueryTitle(candidateTitle);
      if (normalizedCandidate === normalizedTitle) {
        reasons.add("same_outcome");
        score = 1;
      } else {
        const overlap = overlapScore(queryTerms, wishQueryTerms(candidateTitle));
        if (overlap >= 0.5) {
          reasons.add("scope_match");
          score = Math.max(score, Math.min(0.79, 0.4 + overlap * 0.39));
        }
      }
    }
    if (related.has(component.component_id)) {
      reasons.add("declared_relation");
      score = Math.max(score, 0.8);
    }
    if (reasons.size === 0) continue;
    const title = bounded(candidateTitle, WISH_QUERY_TITLE_MAX);
    const locator = bounded(component.document_locator, 512);
    const sprint = input.sprint_bindings?.get(component.component_id);
    matches.push({
      component_id: component.component_id,
      kind: component.kind,
      ...(component.status === undefined ? {} : { status: component.status }),
      state_revision: component.state_revision,
      ...(title.value === undefined ? {} : { title: title.value }),
      title_truncated: component.title_truncated || title.truncated,
      ...(locator.value === undefined ? {} : { locator: locator.value }),
      locator_truncated: component.locator_truncated || locator.truncated,
      ...(sprint === undefined ? {} : { sprint }),
      updated_at: component.updated_at,
      score: Math.round(score * 10_000) / 10_000,
      reason_codes: orderedReasons(reasons),
    });
  }
  matches.sort(compareCandidates);
  const candidateTruncated = matches.length > input.candidate_limit;
  const candidates = matches.slice(0, input.candidate_limit);
  const truncated = input.scan_truncated || candidateTruncated;
  const topReasons = new Set(candidates.flatMap((candidate) => candidate.reason_codes));
  if (truncated) topReasons.add("truncated");
  let disposition: WishQueryDisposition;
  if (candidates.length > 0) disposition = "candidate_found";
  else if (truncated) disposition = "incomplete";
  else {
    disposition = "no_match_within_bounds";
    topReasons.add("no_match_within_bounds");
  }
  return {
    schema: WISH_QUERY_RESULT_SCHEMA,
    use_case: "preflight",
    repository_id: input.repository_id,
    proposed_title: input.proposed_title,
    subject_component_id: subjectId,
    source_revision: sourceRevision,
    disposition,
    reason_codes: orderedReasons(topReasons),
    candidates,
    bounds: {
      scanned: input.components.length,
      scan_limit: input.scan_limit,
      candidate_limit: input.candidate_limit,
      scan_truncated: input.scan_truncated,
      candidate_truncated: candidateTruncated,
    },
    truncated,
    complete: !truncated,
    persistent_delta_bytes: 0,
  };
}
