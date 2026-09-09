export const GENERAL_TASK_SUGGESTIONS = [
  {
    label: "资料分析",
    prompt: "请分析我提供的资料，提炼核心信息、关键结论和待核实的问题。",
  },
  {
    label: "行业调研",
    prompt: "请帮我开展行业调研，先和我明确研究对象、范围及需要回答的问题。",
  },
  {
    label: "内容撰写",
    prompt: "请协助我撰写内容，先了解目标读者、使用场景和已有素材。",
  },
  {
    label: "方案整理",
    prompt: "请将我的想法整理成可执行方案，明确目标、步骤与交付内容。",
  },
] as const;

export function GeneralAgentWelcome() {
  return (
    <div className="general-welcome-heading">
      <img src="/assets/frontmind-wordmark.svg" alt="FrontMind" />
      <h3>有什么想一起完成的？</h3>
      <p>从一个想法、一份资料，或一个具体任务开始。</p>
    </div>
  );
}
