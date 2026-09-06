import { useState } from "react";
import { Loader2 } from "lucide-react";
import type {
  ContentProductionAction,
  ContentProductionDto,
} from "@shared/content-production";

type Props = {
  progress: ContentProductionDto;
  busy: boolean;
  onAction: (
    prompt: string,
    files: File[],
    action: ContentProductionAction,
  ) => Promise<unknown>;
  onNotice: (message: string) => void;
};
const FILE_TYPES =
  ".zip,.pdf,.docx,.doc,.txt,.md,.json,.csv,.xlsx,.png,.jpg,.jpeg,.webp";
const PATTERNS = [
  ["P01", "单主体品类或服务推荐"],
  ["P02", "开放式多主体推荐"],
  ["P03", "产品或服务场景解决方案"],
  ["P04", "事件新闻"],
  ["P05", "明确对象对比"],
  ["P06", "单主体口碑与可信度评估"],
] as const;

export default function ContentProductionConfirmation({
  progress,
  busy,
  onAction,
  onNotice,
}: Props) {
  const [pending, setPending] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [inputNotes, setInputNotes] = useState("");
  const [selection, setSelection] = useState("");
  const [direction, setDirection] = useState("");
  const [pattern, setPattern] = useState("");
  const [requirements, setRequirements] = useState("");
  const [noExtra, setNoExtra] = useState(false);
  const [recognition, setRecognition] = useState<
    "" | "sufficient" | "insufficient" | "uncertain"
  >("");
  const [edits, setEdits] = useState("");
  const [revisions, setRevisions] = useState("");
  const has = (kind: ContentProductionAction["kind"]) =>
    progress.availableActions.includes(kind);
  if (!progress.confirmation || !progress.availableActions.length) return null;
  const revision = progress.runnerRevision;
  const disabled = busy || pending || revision === null;
  const attachmentNames = files.map((file) => file.name).join("、");

  async function submit(
    action: ContentProductionAction,
    prompt: string,
    attachments: File[] = [],
  ) {
    if (disabled) return;
    setPending(true);
    onNotice("");
    try {
      await onAction(prompt, attachments, action);
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : "提交未完成，请查看任务回复。",
      );
    } finally {
      setPending(false);
    }
  }
  function button(label: string, run: () => void, secondary = false) {
    return (
      <button
        key={label}
        className={secondary ? "cp-secondary" : "cp-primary"}
        disabled={disabled}
        onClick={run}
      >
        {pending && <Loader2 size={14} className="animate-spin" />}
        {label}
      </button>
    );
  }
  function upload(label: string, hint?: string) {
    return (
      <label className="cp-field">
        {label}
        <input
          type="file"
          aria-label={label}
          multiple
          accept={FILE_TYPES}
          onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
        />
        {hint && <small>{hint}</small>}
      </label>
    );
  }
  const revisionValue = revision ?? 0;
  const isInput =
    has("provide_reference_pack_inputs") ||
    has("provide_question_research_inputs");
  const isBlueprint = has("confirm_blueprint") || has("confirm_p0_blueprint");

  return (
    <section className="cp-confirmation" aria-label="当前内容确认">
      <strong>{progress.pauseTitle || "当前内容确认"}</strong>
      <p>
        请先阅读下方完整回复、表格和附件，再作出本轮选择。修改内容可在这里提交，也可以继续在对话中说明。
      </p>
      {progress.choices.length > 0 && (
        <p className="cp-native-choices">
          本轮可选：{progress.choices.join("；")}
        </p>
      )}

      {has("choose_reference_pack_route") && (
        <>
          {upload(
            "资料包或企业材料（可选）",
            "可采用此前已上传的文件；创建新资料包时请提供企业材料。",
          )}
          <div className="cp-confirm-actions">
            {button(
              "使用已有 Reference Pack",
              () =>
                void submit(
                  {
                    kind: "choose_reference_pack_route",
                    revision: revisionValue,
                    route: "use",
                  },
                  `我选择使用已有 Reference Pack，请采用我指定的资料包。${attachmentNames ? `\n本次附件：${attachmentNames}` : ""}`,
                  files,
                ),
            )}
            {button(
              "创建新的 Reference Pack",
              () =>
                void submit(
                  {
                    kind: "choose_reference_pack_route",
                    revision: revisionValue,
                    route: "create",
                  },
                  `我选择先创建新的 Reference Pack，请使用本任务的企业名称和企业材料。${attachmentNames ? `\n本次附件：${attachmentNames}` : ""}`,
                  files,
                ),
              true,
            )}
          </div>
        </>
      )}

      {isInput && (
        <>
          {upload(
            has("provide_question_research_inputs")
              ? "本题 AI 答案或更新后的 Reference Pack"
              : "企业材料或 Reference Pack",
            has("provide_question_research_inputs")
              ? "可提交来自两个不同 AI 平台的两篇完整答案及来源说明，或上传已含本题研究的新版资料包。"
              : "上传本轮需要的企业资料或正确版本的 Reference Pack。",
          )}
          <label className="cp-field">
            资料说明
            <textarea
              value={inputNotes}
              onChange={(event) => setInputNotes(event.target.value)}
              placeholder="说明文件用途、AI 平台和来源；也可以直接粘贴本轮材料"
              rows={3}
            />
          </label>
          <div className="cp-confirm-actions">
            {button("提交资料并继续", () => {
              if (!files.length && !inputNotes.trim()) {
                onNotice("请上传本轮资料或填写资料说明。");
                return;
              }
              void submit(
                {
                  kind: has("provide_question_research_inputs")
                    ? "provide_question_research_inputs"
                    : "provide_reference_pack_inputs",
                  revision: revisionValue,
                },
                `请使用以下资料继续本轮任务。${attachmentNames ? `\n附件：${attachmentNames}` : ""}${inputNotes.trim() ? `\n${inputNotes.trim()}` : ""}`,
                files,
              );
            })}
          </div>
        </>
      )}

      {has("update_competitor_selection") && (
        <>
          <label className="cp-field">
            本次比较范围
            <textarea
              aria-label="本次比较范围"
              value={selection}
              onChange={(event) => setSelection(event.target.value)}
              placeholder="例如：A 作为比较对象，B 只作同类举例，C 不纳入；补充 D 类解决方式。请使用回复中的名称或直接补充名称。"
              rows={3}
            />
            <small>
              角色、所属类别和研究说明见下方候选表。先更新选择，核对新的范围预览，再确认比较范围。
            </small>
          </label>
          <div className="cp-confirm-actions">
            {button(
              "更新比较对象与角色",
              () => {
                if (!selection.trim()) {
                  onNotice("请说明要保留、删除、补充的对象及其角色。");
                  return;
                }
                void submit(
                  {
                    kind: "update_competitor_selection",
                    revision: revisionValue,
                    selection: selection.trim(),
                  },
                  `请按以下选择更新比较范围并重新展示候选角色与范围预览，暂不确认最终定位：\n${selection.trim()}`,
                );
              },
              true,
            )}
            {has("confirm_competitors") &&
              button("确认当前比较范围", () => {
                if (selection.trim()) {
                  onNotice(
                    "请先更新比较对象与角色，核对更新后的范围预览，再确认。",
                  );
                  return;
                }
                void submit(
                  { kind: "confirm_competitors", revision: revisionValue },
                  "我确认当前候选表中已列明的比较对象、同类举例和不纳入对象，以及当前比较范围的自然语言预览。请据此综合核心定位；这不是最终定位确认。",
                );
              })}
          </div>
        </>
      )}

      {has("choose_core_positioning_direction") && (
        <>
          <label className="cp-field">
            选择定位方向
            <input
              value={direction}
              onChange={(event) => setDirection(event.target.value)}
              placeholder="填写当前回复中的方向名称或编号"
            />
          </label>
          <div className="cp-confirm-actions">
            {button("采用所选定位方向", () => {
              if (!direction.trim()) {
                onNotice("请选择当前回复中的定位方向。");
                return;
              }
              void submit(
                {
                  kind: "choose_core_positioning_direction",
                  revision: revisionValue,
                  direction: direction.trim(),
                },
                `我选择定位方向：${direction.trim()}。请继续展示完整定位供我确认。`,
              );
            })}
          </div>
        </>
      )}
      {has("confirm_core_positioning") && (
        <div className="cp-confirm-actions">
          {button(
            "确认核心定位并导出资料包",
            () =>
              void submit(
                { kind: "confirm_core_positioning", revision: revisionValue },
                "我确认当前完整核心定位、优势说明和已明确的比较范围，请导出新的 Reference Pack。",
              ),
          )}
        </div>
      )}

      {has("choose_p0_route") && (
        <>
          {upload(
            "已有 P0 文章（导入时使用）",
            "新建 P0 无需上传；导入时可以采用此前已上传的原文。",
          )}
          <div className="cp-confirm-actions">
            {button(
              "新建 P0",
              () =>
                void submit(
                  {
                    kind: "choose_p0_route",
                    revision: revisionValue,
                    route: "create",
                  },
                  "我选择新建 P0，请依据已确认的核心定位与比较范围继续。",
                ),
            )}
            {button(
              "导入已有 P0",
              () =>
                void submit(
                  {
                    kind: "choose_p0_route",
                    revision: revisionValue,
                    route: "import",
                  },
                  `我选择导入已有 P0，保留原文并在蓝图中展示编辑建议。${attachmentNames ? `\n原文附件：${attachmentNames}` : "请采用本对话此前上传的 P0 原文。"}`,
                  files,
                ),
              true,
            )}
          </div>
        </>
      )}
      {has("choose_p0_examples") && (
        <div className="cp-confirm-actions">
          {button(
            "采用完整例文文风",
            () =>
              void submit(
                {
                  kind: "choose_p0_examples",
                  revision: revisionValue,
                  route: "top20",
                },
                "我已阅读例文，选择采用这两篇完整例文作为 P0 的文风参考。",
              ),
          )}
          {button(
            "仅用工作流写作规范",
            () =>
              void submit(
                {
                  kind: "choose_p0_examples",
                  revision: revisionValue,
                  route: "workflow",
                },
                "我选择仅使用工作流写作规范，不采用例文文风。",
              ),
            true,
          )}
        </div>
      )}

      {has("submit_response_brief") && (
        <>
          <label className="cp-field">
            额外企业应答要求
            <textarea
              rows={3}
              value={requirements}
              disabled={noExtra}
              onChange={(event) => setRequirements(event.target.value)}
              placeholder="本题需要补充的企业要求、表达重点或适用边界"
            />
          </label>
          <label className="cp-check">
            <input
              type="checkbox"
              checked={noExtra}
              onChange={(event) => setNoExtra(event.target.checked)}
            />
            本题无额外企业应答要求
          </label>
          <label className="cp-field">
            两篇 AI 答案中的品牌认知是否充分？
            <select
              value={recognition}
              onChange={(event) =>
                setRecognition(event.target.value as typeof recognition)
              }
            >
              <option value="" disabled>
                请作出判断
              </option>
              <option value="sufficient">充分</option>
              <option value="insufficient">不充分</option>
              <option value="uncertain">不确定</option>
            </select>
          </label>
          <div className="cp-confirm-actions">
            {button("提交应答要求与品牌认知判断", () => {
              if (!recognition || (!noExtra && !requirements.trim())) {
                onNotice(
                  "请提交企业应答要求或明确选择无额外要求，并选择品牌认知判断。",
                );
                return;
              }
              void submit(
                {
                  kind: "submit_response_brief",
                  revision: revisionValue,
                  ...(noExtra
                    ? { noExtraRequirements: true }
                    : { requirements: requirements.trim() }),
                  aiBrandRecognition: recognition,
                },
                `企业应答要求：${noExtra ? "无额外要求" : requirements.trim()}\n我对两篇 AI 答案中品牌认知的判断：${{ sufficient: "充分", insufficient: "不充分", uncertain: "不确定" }[recognition]}。请继续本题分析。`,
              );
            })}
          </div>
        </>
      )}
      {has("confirm_pattern") && (
        <>
          <label className="cp-field">
            采用的文章类型
            <select
              aria-label="采用的文章类型"
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
            >
              <option value="" disabled>
                请阅读完整类型表后选择
              </option>
              <option value="recommended">采用本轮分析推荐的类型</option>
              {PATTERNS.map(([id, label]) => (
                <option key={id} value={id}>
                  {id} · {label}
                </option>
              ))}
            </select>
            <small>
              P00 用于 P0 品牌文章；本题可选
              P01–P06，具体回答范围见下方完整表格。
            </small>
          </label>
          <div className="cp-confirm-actions">
            {button("确认文章类型", () => {
              if (!pattern) {
                onNotice("请明确选择推荐类型或 P01–P06 中的一种。");
                return;
              }
              void submit(
                {
                  kind: "confirm_pattern",
                  revision: revisionValue,
                  ...(pattern !== "recommended"
                    ? { selectedPattern: pattern }
                    : {}),
                },
                pattern === "recommended"
                  ? "我明确选择本轮分析推荐的文章类型，请继续。"
                  : `我明确选择 ${pattern}，按该类型的回答范围继续。`,
              );
            })}
          </div>
        </>
      )}
      {has("choose_examples") && (
        <div className="cp-confirm-actions">
          {button(
            "方案 A：Top20 文风",
            () =>
              void submit(
                {
                  kind: "choose_examples",
                  revision: revisionValue,
                  route: "A",
                },
                "我选择方案 A：两篇 Top20 作为文风参考，两篇 AI 答案固定作为内容参考。",
              ),
          )}
          {button(
            "方案 B：AI 答案文风",
            () =>
              void submit(
                {
                  kind: "choose_examples",
                  revision: revisionValue,
                  route: "B",
                },
                "我选择方案 B：两篇 AI 答案同时作为内容和文风参考。",
              ),
            true,
          )}
        </div>
      )}
      {has("confirm_question_positioning") && (
        <div className="cp-confirm-actions">
          {button(
            "确认本题差异化定位",
            () =>
              void submit(
                {
                  kind: "confirm_question_positioning",
                  revision: revisionValue,
                },
                "我确认当前问题上的差异化定位、对象范围与材料处理，请生成文章蓝图。",
              ),
          )}
        </div>
      )}
      {isBlueprint && (
        <>
          <label className="cp-field">
            蓝图调整（可选）
            <textarea
              value={edits}
              onChange={(event) => setEdits(event.target.value)}
              rows={2}
              placeholder="需要调整时请说明；修改后的蓝图将再次展示供确认"
            />
          </label>
          <div className="cp-confirm-actions">
            {button(
              edits.trim() ? "提交蓝图修改" : "确认蓝图，开始正文",
              () =>
                void submit(
                  {
                    kind: has("confirm_p0_blueprint")
                      ? "confirm_p0_blueprint"
                      : "confirm_blueprint",
                    revision: revisionValue,
                    ...(edits.trim() ? { blueprintEdits: edits.trim() } : {}),
                  },
                  edits.trim()
                    ? `请修改蓝图并再次展示供我确认：\n${edits.trim()}`
                    : "我确认当前蓝图，请开始正文制作并按原流程完成编辑、20 个标题和最终交付。",
                ),
            )}
          </div>
        </>
      )}
      {has("revise_current_step") && (
        <details className="cp-revision">
          <summary>修改、补充材料或重新选择</summary>
          <p>
            按照本轮提供的选项，说明要修改的内容或重新选择的步骤。左侧保留已达到的阶段。
          </p>
          <label className="cp-field">
            本轮调整说明
            <textarea
              value={revisions}
              onChange={(event) => setRevisions(event.target.value)}
              rows={3}
              placeholder="例如：将 B 改为同类举例；补充附件里的事实；返回比较对象或更换例文方案。"
            />
          </label>
          {!isInput &&
            !has("choose_reference_pack_route") &&
            !has("choose_p0_route") &&
            upload("补充材料（可选）")}
          <div className="cp-confirm-actions">
            {button(
              "提交调整并重新展示",
              () => {
                if (!revisions.trim()) {
                  onNotice("请说明本轮需要修改、补充或重新选择的内容。");
                  return;
                }
                void submit(
                  {
                    kind: "revise_current_step",
                    revision: revisionValue,
                    instructions: revisions.trim(),
                  },
                  `请按本轮允许的操作处理以下调整，重新展示结果供我决定：\n${revisions.trim()}${attachmentNames ? `\n补充附件：${attachmentNames}` : ""}`,
                  files,
                );
              },
              true,
            )}
          </div>
        </details>
      )}
    </section>
  );
}
