"use client";

import { useState } from "react";
import type { StyleTag, StyleTagKind } from "@/lib/mock";

const KIND_LABEL: Record<StyleTagKind, string> = {
  style: "風格",
  color: "色系",
  mood: "形容詞",
};

const KINDS: StyleTagKind[] = ["style", "color", "mood"];

/** 權重 0~1 對應到字級，權重高的標籤看起來就大一點（像 Your Algorithm）。 */
function sizeFor(weight: number) {
  const clamped = Math.min(1, Math.max(0, weight));
  return `${(15 + clamped * 19).toFixed(1)}px`;
}

export default function TagCloud({
  initialTags,
  readOnly = false,
}: {
  initialTags: StyleTag[];
  readOnly?: boolean;
}) {
  const [tags, setTags] = useState<StyleTag[]>(initialTags);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftKind, setDraftKind] = useState<StyleTagKind>("style");
  const [error, setError] = useState<string | null>(null);

  // --- 新增 -------------------------------------------------------------
  async function addTag() {
    const label = draftLabel.trim();
    if (!label) return;
    setError(null);

    // 之後資料庫接上 Amazon RDS，這支 API 的實作換掉即可（見 src/lib/tags.ts）。
    const res = await fetch("/api/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, kind: draftKind }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      tag?: StyleTag;
      error?: string;
    };
    if (!res.ok || !data.tag) {
      setError(data.error ?? "新增失敗");
      return;
    }
    setTags((prev) => [...prev, data.tag as StyleTag]);
    setDraftLabel("");
    setDraftOpen(false);
  }

  // --- 修改 -------------------------------------------------------------
  async function renameTag(tag: StyleTag, nextLabel: string) {
    setEditingId(null);
    const label = nextLabel.trim();
    if (!label || label === tag.label) return;
    setError(null);

    const before = tags;
    setTags((prev) =>
      prev.map((t) => (t.id === tag.id ? { ...t, label } : t))
    );

    const res = await fetch(`/api/tags/${tag.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "修改失敗");
      setTags(before); // 回復
    }
  }

  async function cycleKind(tag: StyleTag) {
    const next = KINDS[(KINDS.indexOf(tag.kind) + 1) % KINDS.length];
    const before = tags;
    setTags((prev) =>
      prev.map((t) => (t.id === tag.id ? { ...t, kind: next } : t))
    );
    const res = await fetch(`/api/tags/${tag.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: next }),
    });
    if (!res.ok) setTags(before);
  }

  // --- 刪除 -------------------------------------------------------------
  async function removeTag(tag: StyleTag) {
    const before = tags;
    setTags((prev) => prev.filter((t) => t.id !== tag.id));
    const res = await fetch(`/api/tags/${tag.id}`, { method: "DELETE" });
    if (!res.ok) {
      setError("刪除失敗");
      setTags(before);
    }
  }

  return (
    <>
      <div className="tagcloud">
        {tags.map((tag) => (
          <span
            key={tag.id}
            className={`tag tag--${tag.kind}`}
            style={{ fontSize: sizeFor(tag.weight) }}
          >
            {editingId === tag.id && !readOnly ? (
              <input
                className="tag__input"
                defaultValue={tag.label}
                autoFocus
                maxLength={12}
                aria-label={`修改標籤 ${tag.label}`}
                onBlur={(e) => renameTag(tag, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setEditingId(null);
                }}
              />
            ) : (
              <button
                className="tag__text"
                onClick={() => !readOnly && setEditingId(tag.id)}
                onDoubleClick={() => !readOnly && cycleKind(tag)}
                disabled={readOnly}
                title={
                  readOnly
                    ? "資料庫還沒接上，這批是示範標籤"
                    : "點一下改名字，點兩下換分類"
                }
              >
                {tag.label}
              </button>
            )}
            {!readOnly && (
              <button
                className="tag__x"
                onClick={() => removeTag(tag)}
                aria-label={`刪除標籤 ${tag.label}`}
              >
                ×
              </button>
            )}
          </span>
        ))}

        {readOnly ? null : draftOpen ? (
          <span className="tag-draft">
            <label className="visually-hidden" htmlFor="new-tag-kind">
              分類
            </label>
            <select
              id="new-tag-kind"
              value={draftKind}
              onChange={(e) => setDraftKind(e.target.value as StyleTagKind)}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <label className="visually-hidden" htmlFor="new-tag-label">
              新標籤
            </label>
            <input
              id="new-tag-label"
              value={draftLabel}
              autoFocus
              maxLength={12}
              placeholder="新的標籤…"
              onChange={(e) => setDraftLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addTag();
                if (e.key === "Escape") {
                  setDraftOpen(false);
                  setDraftLabel("");
                }
              }}
            />
            <button className="btn btn--tiny" onClick={addTag}>
              加上去
            </button>
            <button
              className="btn btn--tiny"
              onClick={() => {
                setDraftOpen(false);
                setDraftLabel("");
              }}
            >
              取消
            </button>
          </span>
        ) : (
          <button
            className="tag tag--add"
            onClick={() => setDraftOpen(true)}
          >
            ＋ 新增標籤
          </button>
        )}
      </div>

      {error && (
        <p className="form-error" role="status">
          {error}
        </p>
      )}
    </>
  );
}
