import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useDevices } from "../useDevices";
import Control from "./Control";

const STORAGE_KEY = "mt5.multicontrol.tabs";

/**
 * Tabbed multi-phone view: open several phones at once, each in its own tab, and switch between
 * them instantly. Every open tab keeps its own live session (the operator WebSocket is shared and
 * the server tracks one session per phone), so all tabs stay connected in the background.
 *
 * Open tabs are kept in the URL (?ids=a,b,c&active=a) so the view survives a refresh and can be
 * shared, with localStorage as a fallback.
 */
export default function MultiControl() {
  const { devices } = useDevices();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();

  const [openIds, setOpenIds] = useState<string[]>(() => {
    const fromUrl = params.get("ids");
    if (fromUrl) return fromUrl.split(",").filter(Boolean);
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    } catch {
      return [];
    }
  });
  const [activeId, setActiveId] = useState<string>(() => params.get("active") || "");
  const [picking, setPicking] = useState(false);
  const pickRef = useRef<HTMLDivElement>(null);

  // Keep URL + storage in sync with the open tabs.
  useEffect(() => {
    const next = new URLSearchParams(params);
    if (openIds.length) next.set("ids", openIds.join(","));
    else next.delete("ids");
    if (activeId) next.set("active", activeId);
    else next.delete("active");
    setParams(next, { replace: true });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(openIds));
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openIds, activeId]);

  // Make sure something is active whenever tabs exist.
  useEffect(() => {
    if (openIds.length && !openIds.includes(activeId)) setActiveId(openIds[0]);
  }, [openIds, activeId]);

  // Close the "add phone" menu on an outside click.
  useEffect(() => {
    if (!picking) return;
    const onDown = (e: MouseEvent) => {
      if (pickRef.current && !pickRef.current.contains(e.target as Node)) setPicking(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [picking]);

  const nameOf = useMemo(() => {
    const m = new Map((devices ?? []).map((d) => [d.id, d.name] as const));
    return (id: string) => m.get(id) ?? "Phone";
  }, [devices]);

  const openTab = (id: string) => {
    setOpenIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setActiveId(id);
    setPicking(false);
  };

  const closeTab = (id: string) => {
    setOpenIds((prev) => prev.filter((x) => x !== id));
    setActiveId((cur) => (cur === id ? "" : cur));
  };

  const available = (devices ?? []).filter((d) => !openIds.includes(d.id));

  return (
    <div className="multi">
      <div className="tabstrip">
        <button className="ghost tab-home" title="Back to phones" onClick={() => nav("/")}>←</button>
        {openIds.map((id) => {
          const d = devices?.find((x) => x.id === id);
          const online = d?.online ?? false;
          return (
            <div key={id} className={`tab ${id === activeId ? "active" : ""}`} onClick={() => setActiveId(id)}>
              <span className={`dot ${online ? "on" : "off"}`} />
              <span className="tab-name">{nameOf(id)}</span>
              <button
                className="tab-x"
                title="Close this phone"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
        <div className="tab-add" ref={pickRef}>
          <button className="ghost" onClick={() => setPicking((p) => !p)}>
            + Add phone
          </button>
          {picking && (
            <div className="tab-menu">
              {available.length === 0 && <div className="tab-menu-empty">No other phones</div>}
              {available.map((d) => (
                <button key={d.id} className="tab-menu-item" onClick={() => openTab(d.id)}>
                  <span className={`dot ${d.online ? "on" : "off"}`} />
                  {d.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="multi-body">
        {openIds.length === 0 && (
          <div className="multi-empty">
            <p>No phones open.</p>
            <button onClick={() => setPicking(true)}>+ Add a phone</button>
          </div>
        )}
        {openIds.map((id) => (
          <div key={id} className="tabpane" hidden={id !== activeId}>
            <Control deviceId={id} onClose={() => closeTab(id)} />
          </div>
        ))}
      </div>
    </div>
  );
}
