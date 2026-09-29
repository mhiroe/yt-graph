// filesystem 上の Markdown を `DocumentPort` として見せる runtime binding。
//
// **この file は `src/contract.ts` から辿れない。** artifact に `node:fs` が混ざると、
// wishboard の browser build が解決しに行って壊れる。`node_sqlite.ts` と同じ境界。
// `node:fs` / `node:path` は Node 22 と Deno 2 の built-in なので、外部 package を足さない。
//
// この file が持つのは IO だけ。**operation の意味は `src/document_ops.ts` が持つ**。
// write 直前の再読込、atomic replacement、repo root からの escape 検査がここの責務。

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import { err, ok, type Result } from "../result.ts";
import type { ComponentId } from "../ids.ts";
import {
  checkCreateFilePath,
  checkRelativePath,
  type ChildLinkInput,
  type CreateFileInput,
  type CreateTaskInput,
  type DocumentChildrenView,
  type DocumentFileNodes,
  type DocumentLocator,
  type DocumentNodeView,
  type DocumentOutcome,
  type DocumentPort,
  type DocumentTaskView,
  type DocumentView,
  formatDocumentLocator,
  type MoveHeadingInput,
  type MoveTaskInput,
  parseDocumentLocator,
  parseTaskLocator,
  type RegisterComponentIdInput,
  type RenameTitleInput,
  type ReplaceRegionInput,
  type StampIterationPropertiesInput,
} from "../document.ts";
import { applyIterationProperties } from "../iterations.ts";
import {
  applyAttachChild,
  applyCreateTask,
  applyDetachChild,
  applyMoveHeading,
  applyMoveTaskWithinFile,
  applyPlaceTask,
  applyRegisterComponentId,
  applyRemoveTask,
  applyRenameTitle,
  applyReplaceRegion,
  buildDocumentFile,
  type DocumentEdit,
  readChildrenView,
  readDocumentView,
  readNodeList,
  readNodeView,
  readTaskView,
} from "../document_ops.ts";
import { hashSpan, headingSectionCodec, type RegionCodec } from "../region.ts";
import { locateTaskBlock } from "../task_block.ts";

/**
 * component_id から locator を引く。DB の document projection が持つ値を渡す。
 * 引けない component は `not_found` になる。**path や title から推測しない。**
 */
export type LocatorResolver = (componentId: ComponentId) => string | undefined;

export type FsDocumentPortOptions = {
  /** repo root の絶対 path。locator はここからの相対 path として解決する。 */
  readonly root: string;
  readonly resolve_locator: LocatorResolver;
  readonly codec?: RegionCodec;
};

/**
 * repo root の外を指す path を拒否する。
 *
 * lexical 検査だけでは symlink 越えを止められないので、実在する path は realpath でも確認する。
 * 存在しない path は lexical 検査だけで通す (新規 file の作成を止めないため)。
 */
function resolveInsideRoot(root: string, relative: string): Result<string> {
  const checked = checkRelativePath(relative, "locator");
  if (!checked.ok) return checked;
  if (isAbsolute(relative)) {
    return err("locator_escapes_repository", `絶対 path は受け付けない: ${relative}`, "locator");
  }
  const rootReal = existsSync(root) ? realpathSync(root) : resolve(root);
  const target = resolve(rootReal, checked.value);
  const inside = (candidate: string): boolean =>
    candidate === rootReal || candidate.startsWith(rootReal + sep);
  if (!inside(target)) {
    return err("locator_escapes_repository", `repo root の外を指す path: ${relative}`, "locator");
  }
  if (existsSync(target) && !inside(realpathSync(target))) {
    return err(
      "locator_escapes_repository",
      `symlink が repo root の外を指している: ${relative}`,
      "locator",
    );
  }
  return ok(target);
}

/**
 * atomic file replacement。同じ directory へ temp file を書いてから rename する。
 * 途中で落ちても、読み手は書き換え前か書き換え後のどちらかしか見ない。
 * 同じ directory に置くのは、rename が atomic なのが同一 filesystem 内だけのため。
 */
function writeAtomic(target: string, content: string): void {
  const temp = `${target}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temp, content, "utf8");
  try {
    renameSync(temp, target);
  } catch (cause) {
    // rename が失敗したら temp を残さない。次の write が拾って古い内容を書き戻す事故を避ける。
    if (existsSync(temp)) unlinkSync(temp);
    throw cause;
  }
}

export function createFsDocumentPort(options: FsDocumentPortOptions): DocumentPort {
  const codec = options.codec ?? headingSectionCodec;

  const locatorOf = (componentId: ComponentId): Result<DocumentLocator> => {
    const raw = options.resolve_locator(componentId);
    if (raw === undefined) {
      return err(
        "document_not_found",
        `component ${componentId} に document locator が無い`,
        "component_id",
      );
    }
    return parseDocumentLocator(raw, "locator");
  };

  const readFile = (locator: DocumentLocator): Result<{ path: string; raw: string }> => {
    const target = resolveInsideRoot(options.root, locator.path);
    if (!target.ok) return target;
    if (!existsSync(target.value)) {
      return err("document_not_found", `file が無い: ${locator.path}`, "locator");
    }
    return ok({ path: target.value, raw: readFileSync(target.value, "utf8") });
  };

  /** write 直前の再読込はこの 1 経路に閉じる。読んだ raw と書く raw が同じ呼び出しに収まる。 */
  const runEdit = (
    locator: DocumentLocator,
    apply: (raw: string) => Result<DocumentEdit>,
  ): Result<DocumentOutcome> => {
    const file = readFile(locator);
    if (!file.ok) return file;
    const edit = apply(file.value.raw);
    if (!edit.ok) return edit;
    if (edit.value.next_raw !== undefined) {
      writeAtomic(file.value.path, edit.value.next_raw);
    }
    return ok(edit.value.outcome);
  };

  /** task の locator は `path#^<task_id>` だけを受ける。heading 形から推測しない。 */
  const taskLocatorOf = (componentId: ComponentId): Result<DocumentLocator> => {
    const locator = locatorOf(componentId);
    if (!locator.ok) return locator;
    return parseTaskLocator(formatDocumentLocator(locator.value), componentId);
  };

  /**
   * file を跨ぐ task の移動。**移動先へ書いてから移動元から外す。**
   *
   * 2 file の write は atomic ではない。先に外すと、途中で落ちた時に task がどの wish にも
   * 居なくなる。この順なら落ちても task は両方に残り、消えない。再実行すると、移動先に同じ
   * block が既にあることを確かめてから、移動元から外す段へ進む。
   */
  const moveTaskAcrossFiles = (
    input: MoveTaskInput,
    taskLocator: DocumentLocator,
    destinationLocator: DocumentLocator,
  ): Result<DocumentOutcome> => {
    const source = readFile(taskLocator);
    if (!source.ok) return source;
    // 移動先へ触る前に、hash と他 node の identity を検める。
    const checked = applyRemoveTask(source.value.raw, taskLocator, input, codec);
    if (!checked.ok) return checked;
    if (checked.value.outcome.disposition !== "applied") return ok(checked.value.outcome);
    const block = locateTaskBlock(source.value.raw, input.component_id);
    if (!block.ok) return block;

    const destination = readFile(destinationLocator);
    if (!destination.ok) return destination;
    const placement = applyPlaceTask(
      destination.value.raw,
      destinationLocator,
      block.value,
      input.component_id,
      codec,
    );
    if (!placement.ok) return placement;
    const moved = `${destinationLocator.path}#^${input.component_id}`;
    if (placement.value.kind === "clash") {
      return ok({
        disposition: "conflict",
        component_id: input.component_id,
        locator: formatDocumentLocator(taskLocator),
        reason: placement.value.reason,
      });
    }
    if (placement.value.kind === "placed") {
      writeAtomic(destination.value.path, placement.value.next_raw);
    }

    // 2 段目。**write 直前に移動元を読み直し、hash を照合し直す。**
    const again = readFile(taskLocator);
    if (!again.ok) return again;
    const removed = applyRemoveTask(again.value.raw, taskLocator, input, codec);
    if (!removed.ok) return removed;
    if (removed.value.outcome.disposition !== "applied" || removed.value.next_raw === undefined) {
      return ok({
        ...removed.value.outcome,
        disposition: removed.value.outcome.disposition === "rejected" ? "rejected" : "conflict",
        reason: `移動先 ${moved} には置いた。移動元から外せていないので task は両方にある。` +
          `${removed.value.outcome.reason ?? ""}`,
      });
    }
    writeAtomic(again.value.path, removed.value.next_raw);
    return ok({
      disposition: "applied",
      component_id: input.component_id,
      locator: moved,
      observed_hash: placement.value.hash,
    });
  };

  return {
    createFile(input: CreateFileInput): Result<DocumentOutcome> {
      // 範囲検査は dispatch 側も通すが、port 側でも閉じる (port を直接使う consumer 対策)。
      const scoped = checkCreateFilePath(input.path, "path");
      if (!scoped.ok) return scoped;
      const target = resolveInsideRoot(options.root, input.path);
      if (!target.ok) return target;
      if (existsSync(target.value)) {
        // 再送判定: 既存 file の file root anchor が同じ component_id なら noop。
        // 違う anchor / anchor を読めない file は上書きせず conflict。
        const raw = readFileSync(target.value, "utf8");
        const section = codec.locateSection(raw);
        if (section.ok) {
          const anchor = codec.findIdAnchor(raw, section.value);
          if (anchor.ok && anchor.value?.id === input.component_id) {
            return ok({
              disposition: "noop",
              component_id: input.component_id,
              locator: input.path,
              observed_hash: hashSpan(raw, section.value.body),
            });
          }
        }
        return ok({
          disposition: "conflict",
          locator: input.path,
          reason: `path は既に存在し、別の identity を持つ (上書きしない): ${input.path}`,
        });
      }
      const built = buildDocumentFile(input, codec);
      if (!built.ok) return built;
      mkdirSync(dirname(target.value), { recursive: true });
      writeAtomic(target.value, built.value);
      const section = codec.locateSection(built.value);
      const observedHash = section.ok ? hashSpan(built.value, section.value.body) : undefined;
      return ok({
        disposition: "applied",
        component_id: input.component_id,
        locator: input.path,
        ...(observedHash === undefined ? {} : { observed_hash: observedHash }),
      });
    },

    registerComponentId(input: RegisterComponentIdInput): Result<DocumentOutcome> {
      return runEdit(input.locator, (raw) => applyRegisterComponentId(raw, input, codec));
    },

    renameTitle(input: RenameTitleInput): Result<DocumentOutcome> {
      const locator = locatorOf(input.component_id);
      if (!locator.ok) return locator;
      return runEdit(locator.value, (raw) => applyRenameTitle(raw, locator.value, input, codec));
    },

    replaceRegion(input: ReplaceRegionInput): Result<DocumentOutcome> {
      const locator = locatorOf(input.component_id);
      if (!locator.ok) return locator;
      return runEdit(locator.value, (raw) => applyReplaceRegion(raw, locator.value, input, codec));
    },

    readRaw(componentId: ComponentId): Result<DocumentView> {
      const locator = locatorOf(componentId);
      if (!locator.ok) return locator;
      const file = readFile(locator.value);
      if (!file.ok) return file;
      return readDocumentView(file.value.raw, componentId, locator.value, codec);
    },

    inspectLocator(locator: DocumentLocator): Result<DocumentNodeView> {
      const file = readFile(locator);
      if (!file.ok) return file;
      return readNodeView(file.value.raw, locator, codec);
    },

    listNodes(path: string): Result<DocumentFileNodes> {
      const file = readFile({ path });
      if (!file.ok) return file;
      return readNodeList(file.value.raw, path, codec);
    },

    readChildren(componentId: ComponentId): Result<DocumentChildrenView> {
      const locator = locatorOf(componentId);
      if (!locator.ok) return locator;
      const file = readFile(locator.value);
      if (!file.ok) return file;
      return readChildrenView(file.value.raw, componentId, locator.value);
    },

    attachChild(input: ChildLinkInput): Result<DocumentOutcome> {
      const locator = locatorOf(input.component_id);
      if (!locator.ok) return locator;
      return runEdit(locator.value, (raw) => applyAttachChild(raw, locator.value, input, codec));
    },

    detachChild(input: ChildLinkInput): Result<DocumentOutcome> {
      const locator = locatorOf(input.component_id);
      if (!locator.ok) return locator;
      return runEdit(locator.value, (raw) => applyDetachChild(raw, locator.value, input, codec));
    },

    readTask(componentId: ComponentId): Result<DocumentTaskView> {
      const locator = taskLocatorOf(componentId);
      if (!locator.ok) return locator;
      const file = readFile(locator.value);
      if (!file.ok) return file;
      return readTaskView(file.value.raw, componentId, locator.value.path, codec);
    },

    moveTask(input: MoveTaskInput): Result<DocumentOutcome> {
      const taskLocator = taskLocatorOf(input.component_id);
      if (!taskLocator.ok) return taskLocator;
      const destination = locatorOf(input.new_parent_component_id);
      if (!destination.ok) return destination;
      if (destination.value.path !== taskLocator.value.path) {
        return moveTaskAcrossFiles(input, taskLocator.value, destination.value);
      }
      return runEdit(
        taskLocator.value,
        (raw) => applyMoveTaskWithinFile(raw, taskLocator.value, destination.value, input, codec),
      );
    },

    moveHeading(input: MoveHeadingInput): Result<DocumentOutcome> {
      const locator = locatorOf(input.component_id);
      if (!locator.ok) return locator;
      const parent = locatorOf(input.new_parent_component_id);
      if (!parent.ok) return parent;
      return runEdit(
        locator.value,
        (raw) => applyMoveHeading(raw, locator.value, parent.value, input, codec),
      );
    },

    createTask(input: CreateTaskInput): Result<DocumentOutcome> {
      return runEdit(
        input.locator,
        (raw) => applyCreateTask(raw, input, codec),
      );
    },

    stampIterationProperties(
      input: StampIterationPropertiesInput,
    ): Result<{ readonly changed: boolean }> {
      // DocumentPort は `.md` だけを書く。dir / symlink は IterationFsPort の仕事。
      const checked = checkRelativePath(input.path, "path");
      if (!checked.ok) return checked;
      if (!checked.value.endsWith(".md")) {
        return err(
          "invalid_locator",
          `stampIterationProperties は .md file にだけ書く: ${input.path}`,
          "path",
        );
      }
      const target = resolveInsideRoot(options.root, checked.value);
      if (!target.ok) return target;
      if (!existsSync(target.value)) {
        return err("document_not_found", `file が無い: ${input.path}`, "path");
      }
      const raw = readFileSync(target.value, "utf8");
      const stamped = applyIterationProperties(raw, input.properties);
      if (!stamped.ok) return stamped;
      if (stamped.value.changed) writeAtomic(target.value, stamped.value.raw);
      return ok({ changed: stamped.value.changed });
    },
  };
}
