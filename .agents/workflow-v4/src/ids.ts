// identity は repository_id + component_id で表す。path、title、位置を identity の代用にしない。

import { err, ok, type Result } from "./result.ts";

declare const repositoryIdBrand: unique symbol;
declare const componentIdBrand: unique symbol;

export type RepositoryId = string & { readonly [repositoryIdBrand]: true };
export type ComponentId = string & { readonly [componentIdBrand]: true };

/** address の区切りに使うため ":" は id charset から除く。 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const ADDRESS_SEPARATOR = ":";

function parseId(value: unknown, label: string, path?: string): Result<string> {
  if (typeof value !== "string") {
    return err("invalid_field_type", `${label} は string である必要がある`, path);
  }
  if (!ID_PATTERN.test(value)) {
    return err("invalid_id", `${label} が id 形式に一致しない: ${JSON.stringify(value)}`, path);
  }
  return ok(value);
}

export function parseRepositoryId(value: unknown, path?: string): Result<RepositoryId> {
  const parsed = parseId(value, "repository_id", path);
  return parsed.ok ? ok(parsed.value as RepositoryId) : parsed;
}

export function parseComponentId(value: unknown, path?: string): Result<ComponentId> {
  const parsed = parseId(value, "component_id", path);
  return parsed.ok ? ok(parsed.value as ComponentId) : parsed;
}

/** entity の identity。片方だけでは identity にならない。 */
export type ComponentAddress = {
  readonly repository_id: RepositoryId;
  readonly component_id: ComponentId;
};

export function componentAddress(
  repositoryId: RepositoryId,
  componentId: ComponentId,
): ComponentAddress {
  return { repository_id: repositoryId, component_id: componentId };
}

export function parseComponentAddress(value: unknown, path?: string): Result<ComponentAddress> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err("invalid_address", "component address は object である必要がある", path);
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== "repository_id" && key !== "component_id") {
      return err("unexpected_field", `component address に未知の field がある: ${key}`, path);
    }
  }
  const repositoryId = parseRepositoryId(raw["repository_id"], joinPath(path, "repository_id"));
  if (!repositoryId.ok) return repositoryId;
  const componentId = parseComponentId(raw["component_id"], joinPath(path, "component_id"));
  if (!componentId.ok) return componentId;
  return ok(componentAddress(repositoryId.value, componentId.value));
}

/** 表示と dedupe 用の正規形。`repository_id:component_id`。 */
export function formatComponentAddress(address: ComponentAddress): string {
  return `${address.repository_id}${ADDRESS_SEPARATOR}${address.component_id}`;
}

export function parseComponentAddressString(
  value: unknown,
  path?: string,
): Result<ComponentAddress> {
  if (typeof value !== "string") {
    return err("invalid_field_type", "component address string が string でない", path);
  }
  const index = value.indexOf(ADDRESS_SEPARATOR);
  if (index < 0 || value.indexOf(ADDRESS_SEPARATOR, index + 1) >= 0) {
    return err("invalid_address", `component address 形式が不正: ${JSON.stringify(value)}`, path);
  }
  const repositoryId = parseRepositoryId(value.slice(0, index), path);
  if (!repositoryId.ok) return repositoryId;
  const componentId = parseComponentId(value.slice(index + 1), path);
  if (!componentId.ok) return componentId;
  return ok(componentAddress(repositoryId.value, componentId.value));
}

export function sameAddress(left: ComponentAddress, right: ComponentAddress): boolean {
  return left.repository_id === right.repository_id && left.component_id === right.component_id;
}

export function joinPath(base: string | undefined, segment: string): string {
  return base === undefined ? segment : `${base}.${segment}`;
}

declare const deviceIdBrand: unique symbol;
declare const operationIdBrand: unique symbol;
declare const eventIdBrand: unique symbol;

/** device_id は DB を作り直しても再利用しない。identity ではなく発生源の識別に使う。 */
export type DeviceId = string & { readonly [deviceIdBrand]: true };

/** operation_id は retry の同一性を決める。同じ id で異なる request digest は拒否する。 */
export type OperationId = string & { readonly [operationIdBrand]: true };

export function parseDeviceId(value: unknown, path?: string): Result<DeviceId> {
  const parsed = parseId(value, "device_id", path);
  return parsed.ok ? ok(parsed.value as DeviceId) : parsed;
}

export function parseOperationId(value: unknown, path?: string): Result<OperationId> {
  const parsed = parseId(value, "operation_id", path);
  return parsed.ok ? ok(parsed.value as OperationId) : parsed;
}

/**
 * committed DomainEvent の identity (Slice D)。Journal 上でも `EVENT_INBOX` でも同じ値を使う。
 *
 * **repository を付けない。** event は必ずどれか 1 つの repo の DB に属し、`DOMAIN_EVENTS` は
 * repository_id 列を持たない (`REPOSITORY` の single row から補える)。address 化すると、DB が
 * 保持できない値を型として表現できてしまう。cross-repo で運ぶときは `JournalRecord` が
 * `repository_id` を envelope 側に持つ。
 */
export type EventId = string & { readonly [eventIdBrand]: true };

/**
 * event id 用の charset。`parseId` と同じ形だが **長さの上限だけを 128 にする**。
 * 既定の採番が `ev-<operation_id>` で、operation_id 自体が最大 64 文字あるため、
 * 64 文字上限のままだと自分で採番した event id を自分で parse できない。
 */
const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function parseEventId(value: unknown, path?: string): Result<EventId> {
  if (typeof value !== "string") {
    return err("invalid_field_type", "event_id は string である必要がある", path);
  }
  if (!EVENT_ID_PATTERN.test(value)) {
    return err("invalid_id", `event_id が id 形式に一致しない: ${JSON.stringify(value)}`, path);
  }
  return ok(value as EventId);
}
