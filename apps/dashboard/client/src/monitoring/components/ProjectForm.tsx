import { useState, type FormEvent } from "react";

import type { ProjectSummary } from "../domain";

type ProjectFormProps = {
  initial?: ProjectSummary;
  submitting?: boolean;
  onCancel: () => void;
  onSubmit: (value: Omit<ProjectSummary, "id">) => void | Promise<void>;
};

function parseTags(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[，,\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ).slice(0, 50);
}

function parseCompetitors(value: string) {
  const seen = new Set<string>();
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [rawName, ...rawAliases] = line.split(/[｜|]/);
      const name = rawName?.trim() || "";
      const normalizedName = name.toLocaleLowerCase("zh-CN");
      if (!name || seen.has(normalizedName)) return [];
      seen.add(normalizedName);
      return [
        {
          name,
          aliases: parseTags(rawAliases.join("，")).slice(0, 20),
        },
      ];
    })
    .slice(0, 20);
}

function serializeCompetitors(
  competitors: ProjectSummary["competitors"] | undefined,
) {
  return (competitors || [])
    .map(
      (competitor) =>
        `${competitor.name}${
          competitor.aliases.length ? `｜${competitor.aliases.join("，")}` : ""
        }`,
    )
    .join("\n");
}

export default function ProjectForm({
  initial,
  submitting,
  onCancel,
  onSubmit,
}: ProjectFormProps) {
  const [name, setName] = useState(initial?.name || "");
  const [brandName, setBrandName] = useState(initial?.brandName || "");
  const [timezone, setTimezone] = useState(
    initial?.timezone || "Asia/Shanghai",
  );
  const [aliases, setAliases] = useState(
    initial?.brandAliases.join("，") || "",
  );
  const [competitors, setCompetitors] = useState(
    serializeCompetitors(initial?.competitors),
  );
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !brandName.trim()) {
      setError("请填写项目名称和主品牌名称。");
      return;
    }
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone.trim() }).format();
    } catch {
      setError("请输入有效的 IANA 时区，例如 Asia/Shanghai。");
      return;
    }
    await onSubmit({
      name: name.trim(),
      brandName: brandName.trim(),
      brandAliases: parseTags(aliases),
      competitors: parseCompetitors(competitors),
      timezone: timezone.trim(),
    });
  };

  return (
    <form className="modal-form" onSubmit={(event) => void submit(event)}>
      <div className="modal-body project-form-grid">
        <label className="field">
          <span>
            项目名称 <b>*</b>
          </span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            placeholder="例如：FrontMind 品牌监测"
          />
        </label>
        <label className="field">
          <span>
            主品牌名称 <b>*</b>
          </span>
          <input
            value={brandName}
            onChange={(event) => setBrandName(event.target.value)}
            maxLength={80}
            placeholder="请输入一个主品牌"
          />
        </label>
        <label className="field field-wide">
          <span>
            默认时区 <b>*</b>
          </span>
          <input
            list="project-timezones"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            maxLength={64}
            required
            placeholder="Asia/Shanghai"
          />
          <datalist id="project-timezones">
            <option value="Asia/Shanghai" />
            <option value="Asia/Hong_Kong" />
            <option value="Asia/Singapore" />
            <option value="Europe/London" />
            <option value="America/New_York" />
            <option value="UTC" />
          </datalist>
          <small>请输入标准 IANA 时区；新监控默认继承此值。</small>
        </label>
        <label className="field field-wide">
          <span>品牌别名</span>
          <textarea
            value={aliases}
            onChange={(event) => setAliases(event.target.value)}
            rows={3}
            placeholder="用逗号或换行分隔，最多 50 个"
          />
          <small>{parseTags(aliases).length}/50</small>
        </label>
        <label className="field field-wide">
          <span>竞品品牌</span>
          <textarea
            aria-label="竞品品牌"
            value={competitors}
            onChange={(event) => setCompetitors(event.target.value)}
            rows={4}
            placeholder={"每行一个，例如：竞品 A｜别名 1，别名 2"}
          />
          <small>
            每行填写一个竞品；“｜”后可填写别名。最多 20 个竞品，每个 20 个别名。
          </small>
        </label>
        {error && <p className="form-error field-wide">{error}</p>}
      </div>
      <footer className="modal-footer">
        <button type="button" className="ghost-button" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="primary-button" disabled={submitting}>
          {submitting ? "正在保存…" : "保存项目"}
        </button>
      </footer>
    </form>
  );
}
