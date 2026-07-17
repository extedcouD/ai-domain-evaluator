/**
 * ContextMenu — a small fixed-position floating menu, opened at a pointer position and closed by
 * clicking (or right-clicking) anywhere outside it. Purely presentational; callers own the open/closed
 * state and the item actions.
 */
export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

export function ContextMenu({
  x,
  y,
  target,
  items,
  onClose,
}: {
  x: number;
  y: number;
  target: string;
  items: ContextMenuItem[];
  onClose: () => void;
}): React.JSX.Element {
  return (
    <>
      <div className="ctx-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className="ctx-menu" style={{ left: x, top: y }}>
        <div className="ctx-target">{target}</div>
        {items.map((m, i) => (
          <button
            key={i}
            type="button"
            className={`ctx-item${m.danger ? " danger" : ""}`}
            onClick={() => {
              onClose();
              m.onClick();
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
    </>
  );
}

/** Clamp a menu's top-left so it stays fully on-screen given an approximate size. */
export function clampMenuPos(clientX: number, clientY: number, width = 210, height = 190): { x: number; y: number } {
  return {
    x: Math.min(clientX, window.innerWidth - width),
    y: Math.min(clientY, window.innerHeight - height),
  };
}
