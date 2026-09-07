import { Package, Play, Video } from "lucide-react";
import { useMonitoringDemo } from "../../../MonitoringDemoContext";
import PanelFrame from "./PanelFrame";

export default function MediaStatisticsPanel({
  kind,
}: {
  kind: "goods" | "videos";
}) {
  const demo = useMonitoringDemo();
  const goods = kind === "goods";
  const title = goods ? "商品统计" : "视频统计";
  return (
    <PanelFrame
      id={`monitor-${kind}`}
      labelledBy={`monitor-tab-${kind}`}
      icon={goods ? <Package size={17} /> : <Video size={17} />}
      title={title}
      meta={demo ? "合成演示数据" : "暂无数据"}
    >
      {demo ? (
        <>
          <p className="fm-media-demo-note">
            以下为布局演示，不代表监控平台返回了真实{goods ? "商品" : "视频"}
            记录。
          </p>
          <div className="fm-demo-media-grid">
            {(goods
              ? [
                  "轻木系列 · 小户型边柜",
                  "云杉系列 · 原木茶几",
                  "日常系列 · 模块书架",
                ]
              : ["小空间的收纳与生活动线", "如何挑选适合自己的实木家具"]
            ).map((name, index) => (
              <article key={name}>
                <div className={`fm-demo-media-art tone-${index}`}>
                  {goods ? <Package size={42} /> : <Play size={42} />}
                  <span>演示素材</span>
                </div>
                <strong>{name}</strong>
                <small>
                  {goods ? "合成商品条目" : "合成视频条目"} · {index + 2} 次出现
                </small>
                <p>
                  {goods
                    ? "商品信息来源与出现次数将在获得完整数据后展示。"
                    : "视频标题与引用关联的展示样式。"}
                </p>
              </article>
            ))}
          </div>
        </>
      ) : (
        <div className="fm-detail-empty fm-media-empty">
          {goods ? <Package size={32} /> : <Video size={32} />}
          <h3>暂未获得{goods ? "商品" : "视频"}数据</h3>
          <p>当前监控结果尚未提供可核验的{goods ? "商品" : "视频"}明细。</p>
        </div>
      )}
    </PanelFrame>
  );
}
