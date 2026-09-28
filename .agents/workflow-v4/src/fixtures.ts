// contract fixture の型付き入口。
// dotfiles 側の test と wishboard client の test が同じ fixture を読み、契約のずれを検出する。

import commandsFixture from "../fixtures/commands.json" with { type: "json" };
import transitionsFixture from "../fixtures/transitions.json" with { type: "json" };
import relationsFixture from "../fixtures/relations.json" with { type: "json" };
import handshakeFixture from "../fixtures/handshake.json" with { type: "json" };
import changesFixture from "../fixtures/changes.json" with { type: "json" };
import idempotencyFixture from "../fixtures/idempotency.json" with { type: "json" };
import responsesFixture from "../fixtures/responses.json" with { type: "json" };
import documentsFixture from "../fixtures/documents.json" with { type: "json" };
import replicationFixture from "../fixtures/replication.json" with { type: "json" };

import type { WorkflowErrorCode } from "./result.ts";

/** 失敗を期待する case の共通形。code は WorkflowErrorCode と一致させる。 */
export type ExpectResult = {
  readonly ok: boolean;
  readonly code?: WorkflowErrorCode;
  readonly path?: string;
};

export const fixtures = {
  commands: commandsFixture,
  transitions: transitionsFixture,
  relations: relationsFixture,
  handshake: handshakeFixture,
  changes: changesFixture,
  idempotency: idempotencyFixture,
  responses: responsesFixture,
  documents: documentsFixture,
  replication: replicationFixture,
} as const;

export type Fixtures = typeof fixtures;
