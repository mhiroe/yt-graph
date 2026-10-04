import { useState } from "react";
import type { ParentalLock } from "../core/limits";

export function ParentPanel({
  lock,
  onChange,
}: {
  lock: ParentalLock;
  onChange: () => void;
}) {
  const [pin, setPin] = useState("");
  const [open, setOpen] = useState(false);
  const [daily, setDaily] = useState(String(lock.policy().dailyCapMinutes));
  const [session, setSession] = useState(String(lock.policy().sessionCapMinutes));
  const [denied, setDenied] = useState(false);

  const locked = lock.isLocked();

  const tryUnlock = async () => {
    const okPin = await lock.unlock(pin);
    setDenied(!okPin);
    setPin("");
    onChange();
  };

  const savePolicy = () => {
    const okSave = lock.setPolicy({
      dailyCapMinutes: Number(daily) || 0,
      sessionCapMinutes: Number(session) || 0,
    });
    setDenied(!okSave);
    onChange();
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ marginLeft: "auto" }}>
        parent {locked ? "(locked)" : "(open)"}
      </button>
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        top: 40,
        right: 12,
        background: "#1c1c1c",
        border: "1px solid #444",
        padding: 12,
        width: 240,
        fontSize: 13,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <strong>parental controls</strong>
        <button onClick={() => setOpen(false)}>x</button>
      </div>
      <div style={{ margin: "8px 0" }}>
        daily cap{" "}
        <input
          value={daily}
          disabled={locked}
          onChange={(e) => setDaily(e.target.value)}
          style={{ width: 50 }}
        />{" "}
        min
        <br />
        session cap{" "}
        <input
          value={session}
          disabled={locked}
          onChange={(e) => setSession(e.target.value)}
          style={{ width: 50 }}
        />{" "}
        min
      </div>
      {locked ? (
        <div>
          <input
            type="password"
            placeholder="parent PIN"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            style={{ width: 120 }}
          />
          <button onClick={tryUnlock}>unlock</button>
        </div>
      ) : (
        <div>
          <button onClick={savePolicy}>save limits</button>
          <br />
          <input
            type="password"
            placeholder="new PIN"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            style={{ width: 120 }}
          />
          <button
            onClick={async () => {
              await lock.setPin(pin);
              setPin("");
              onChange();
            }}
          >
            set PIN & lock
          </button>
        </div>
      )}
      {denied && <div style={{ color: "#ff7777" }}>locked — parent PIN required</div>}
    </div>
  );
}
