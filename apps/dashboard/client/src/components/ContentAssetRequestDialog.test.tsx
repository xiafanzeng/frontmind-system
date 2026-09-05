import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ContentAssetRequestDialog from "./ContentAssetRequestDialog";

const assetType = {
  id: "B3",
  group: "B 类：权威长内容",
  name: "用户案例与成功故事",
  description: "客户成功案例",
};

function contentQuota(used = 0, limit = 5) {
  return {
    type: "content_asset_publish" as const,
    allowed: true,
    used,
    reserved: used,
    consumed: 0,
    limit,
    remaining: Math.max(limit - used, 0),
    periodId: "period-1",
    validFrom: null,
    validUntil: null,
    reason: null,
  };
}

describe("ContentAssetRequestDialog", () => {
  it("uses the isolated overseas media list when supplied by the account workspace", () => {
    render(
      <ContentAssetRequestDialog
        open
        onOpenChange={() => undefined}
        assetType={assetType}
        planCode="advanced"
        quota={contentQuota()}
        preferredMediaOptions={[
          "美联社",
          "今日美国",
          "雅虎",
          "Business Insider",
          "Barchart",
        ]}
      />,
    );

    const media = screen.getByLabelText("意向媒体");
    expect(media).toHaveTextContent("美联社");
    expect(media).toHaveTextContent("今日美国");
    expect(media).toHaveTextContent("雅虎");
    expect(media).toHaveTextContent("Business Insider");
    expect(media).toHaveTextContent("Barchart");
    expect(media).not.toHaveTextContent("搜狐");
  });

  it("fails closed without an authoritative content quota", () => {
    render(
      <ContentAssetRequestDialog
        open
        onOpenChange={vi.fn()}
        assetType={assetType}
        planCode="basic"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "内容需求服务尚未解锁" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/当前账号暂不能提交内容需求/)).toBeInTheDocument();
    expect(screen.queryByText(/进阶版.*5 次/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "提交给管理员" }),
    ).not.toBeInTheDocument();
  });

  it("submits optional topic, materials, notes and files through the callback", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    const file = new File(["image"], "factory.jpg", {
      type: "image/jpeg",
    });

    render(
      <ContentAssetRequestDialog
        open
        onOpenChange={onOpenChange}
        assetType={assetType}
        planCode="advanced"
        quota={contentQuota(2)}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByText("剩余 3 次")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/话题方向/), {
      target: { value: " 制造业客户案例 " },
    });
    fireEvent.change(screen.getByLabelText(/内容资料/), {
      target: { value: " 企业交付资料 " },
    });
    fireEvent.change(screen.getByLabelText("意向媒体"), {
      target: { value: "新浪" },
    });
    fireEvent.change(screen.getByLabelText("参考链接"), {
      target: {
        value: "https://example.com/case\nhttps://example.com/source",
      },
    });
    fireEvent.change(screen.getByLabelText("图片或附件说明"), {
      target: { value: " 已获得图片授权 " },
    });
    fireEvent.change(screen.getByLabelText(/图片用途/), {
      target: { value: " 文章首图 " },
    });
    fireEvent.change(screen.getByLabelText("图片授权情况"), {
      target: { value: "licensed" },
    });
    fireEvent.change(screen.getByLabelText("图片版权说明"), {
      target: { value: " 客户已书面授权 " },
    });
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交给管理员" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        assetTypeId: "B3",
        assetTypeName: "用户案例与成功故事",
        assetGroup: "B 类：权威长内容",
        topicDirection: "制造业客户案例",
        preferredMedia: "新浪",
        contentMaterials: "企业交付资料",
        materialUrls: [
          "https://example.com/case",
          "https://example.com/source",
        ],
        attachmentNotes: "已获得图片授权",
        imagePurpose: "文章首图",
        copyrightAuthorization: "licensed",
        copyrightNote: "客户已书面授权",
        attachmentFiles: [file],
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("allows an asset-type-only ticket because every input field is optional", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <ContentAssetRequestDialog
        open
        onOpenChange={vi.fn()}
        assetType={assetType}
        planCode="luxury"
        quota={contentQuota(0, 20)}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "提交给管理员" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          assetTypeId: "B3",
          topicDirection: "",
          preferredMedia: "",
          contentMaterials: "",
          materialUrls: [],
          attachmentNotes: "",
          imagePurpose: "",
          copyrightAuthorization: "",
          copyrightNote: "",
          attachmentFiles: [],
        }),
      ),
    );
  });

  it("prevents submission after the service-cycle quota is exhausted", () => {
    render(
      <ContentAssetRequestDialog
        open
        onOpenChange={vi.fn()}
        assetType={assetType}
        planCode="luxury"
        quota={contentQuota(20, 20)}
        onSubmit={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "本服务周期额度已用完" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "提交给管理员" }),
    ).not.toBeInTheDocument();
  });

  it("validates reference URLs for a configured content type", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ContentAssetRequestDialog
        open
        onOpenChange={vi.fn()}
        assetType={assetType}
        planCode="advanced"
        quota={contentQuota()}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText(/话题方向/), {
      target: { value: "企业新产品发布" },
    });
    fireEvent.change(screen.getByLabelText("参考链接"), {
      target: { value: "不是一个网址" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交给管理员" }));
    expect(screen.getByText(/参考链接格式不正确/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
