import Image from "@tiptap/extension-image";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Heading2,
  ImagePlus,
  Italic,
  List,
  LoaderCircle,
  Quote,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  publisherCanonicalHtmlToEditorHtml,
  publisherHtmlToPlainText,
  sanitizePublisherEditorHtml,
} from "../editorContent";
import type { ArticleImage, PublisherEditorContent } from "../types";

export type TipTapArticleEditorProps = {
  value: PublisherEditorContent;
  images: readonly ArticleImage[];
  onChange: (value: PublisherEditorContent) => void;
  onUploadImage: (file: File) => Promise<ArticleImage>;
};

const ArticleImageNode = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      "data-asset-id": {
        default: null,
        parseHTML: (element) => element.getAttribute("data-asset-id"),
      },
    };
  },
});

export default function TipTapArticleEditor({
  value,
  images,
  onChange,
  onUploadImage,
}: TipTapArticleEditorProps) {
  const imagesRef = useRef(images);
  const onChangeRef = useRef(onChange);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [imageError, setImageError] = useState("");
  const [, renderToolbarState] = useState(0);
  imagesRef.current = images;
  onChangeRef.current = onChange;

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
      }),
      ArticleImageNode.configure({
        allowBase64: false,
        inline: false,
      }),
    ],
    content: publisherCanonicalHtmlToEditorHtml(value.html, images),
    editorProps: {
      attributes: {
        "aria-label": "稿件正文",
        class: "publishing-editor-prosemirror",
        role: "textbox",
        spellcheck: "true",
      },
      transformPastedHTML: (html) =>
        sanitizePublisherEditorHtml(html, imagesRef.current),
    },
    onUpdate: ({ editor: nextEditor }) => {
      const safeHtml = sanitizePublisherEditorHtml(
        nextEditor.getHTML(),
        imagesRef.current,
      );
      const editorHtml = publisherCanonicalHtmlToEditorHtml(
        safeHtml,
        imagesRef.current,
      );
      if (editorHtml !== nextEditor.getHTML()) {
        nextEditor.commands.setContent(editorHtml, { emitUpdate: false });
      }
      onChangeRef.current({
        html: safeHtml,
        text: publisherHtmlToPlainText(safeHtml),
        json: nextEditor.getJSON() as Record<string, unknown>,
      });
    },
  });

  useEffect(() => {
    if (!editor) return;
    const refresh = () => renderToolbarState((version) => version + 1);
    editor.on("selectionUpdate", refresh);
    editor.on("transaction", refresh);
    return () => {
      editor.off("selectionUpdate", refresh);
      editor.off("transaction", refresh);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const editorHtml = publisherCanonicalHtmlToEditorHtml(value.html, images);
    if (editorHtml !== editor.getHTML()) {
      editor.commands.setContent(editorHtml, { emitUpdate: false });
    }
  }, [editor, images, value.html]);

  const insertUploadedImage = async (file: File) => {
    if (!editor) return;
    setUploadingImage(true);
    setImageError("");
    try {
      const image = await onUploadImage(file);
      if (!image.sourceUrl || !image.previewUrl) {
        throw new Error("图片已上传，但安全预览尚未就绪");
      }
      imagesRef.current = [
        ...imagesRef.current.filter((candidate) => candidate.id !== image.id),
        image,
      ];
      editor
        .chain()
        .focus()
        .insertContent({
          type: "image",
          attrs: {
            src: image.previewUrl,
            alt: image.altText,
            "data-asset-id": image.id,
          },
        })
        .run();
    } catch (reason) {
      setImageError(reason instanceof Error ? reason.message : "图片上传失败");
    } finally {
      setUploadingImage(false);
      if (imageInputRef.current) imageInputRef.current.value = "";
    }
  };

  return (
    <div className="publishing-editor-surface">
      <div
        className="publishing-editor-toolbar"
        role="toolbar"
        aria-label="稿件格式"
      >
        <ToolbarButton
          label="二级标题"
          active={editor?.isActive("heading", { level: 2 }) ?? false}
          disabled={!editor}
          onPress={() =>
            editor?.chain().focus().toggleHeading({ level: 2 }).run()
          }
        >
          <Heading2 size={18} />
        </ToolbarButton>
        <ToolbarButton
          label="粗体"
          active={editor?.isActive("bold") ?? false}
          disabled={!editor}
          onPress={() => editor?.chain().focus().toggleBold().run()}
        >
          <Bold size={18} />
        </ToolbarButton>
        <ToolbarButton
          label="斜体"
          active={editor?.isActive("italic") ?? false}
          disabled={!editor}
          onPress={() => editor?.chain().focus().toggleItalic().run()}
        >
          <Italic size={18} />
        </ToolbarButton>
        <ToolbarButton
          label="引用"
          active={editor?.isActive("blockquote") ?? false}
          disabled={!editor}
          onPress={() => editor?.chain().focus().toggleBlockquote().run()}
        >
          <Quote size={18} />
        </ToolbarButton>
        <ToolbarButton
          label="项目列表"
          active={editor?.isActive("bulletList") ?? false}
          disabled={!editor}
          onPress={() => editor?.chain().focus().toggleBulletList().run()}
        >
          <List size={18} />
        </ToolbarButton>
        <span
          className="publishing-editor-toolbar-divider"
          aria-hidden="true"
        />
        <ToolbarButton
          label="插入图片"
          active={false}
          disabled={!editor || uploadingImage}
          onPress={() => imageInputRef.current?.click()}
        >
          {uploadingImage ? (
            <LoaderCircle className="publishing-spin" size={18} />
          ) : (
            <ImagePlus size={18} />
          )}
        </ToolbarButton>
        <input
          ref={imageInputRef}
          className="publishing-visually-hidden"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          aria-label="选择要插入的图片"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void insertUploadedImage(file);
          }}
        />
        {imageError ? (
          <span className="publishing-editor-toolbar-error" role="alert">
            {imageError}
          </span>
        ) : null}
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}

function ToolbarButton({
  label,
  active,
  disabled,
  onPress,
  children,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      className={active ? "is-active" : undefined}
      disabled={disabled}
      onClick={onPress}
    >
      {children}
    </button>
  );
}
