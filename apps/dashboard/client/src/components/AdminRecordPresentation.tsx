import type { ReactNode } from "react";

/** Shared identity and progressive disclosure for the existing admin pages. */
export function AdminRecordIdentity({
  name,
  account,
  children,
}: {
  name: ReactNode;
  account?: string | null;
  children?: ReactNode;
}) {
  return (
    <span className="block min-w-0 text-black">
      <span className="block truncate text-sm font-semibold">{name}</span>
      {account && (
        <span className="mt-1 block truncate text-xs text-[#595959]">
          {account.startsWith("@") ? account : `@${account}`}
        </span>
      )}
      {children}
    </span>
  );
}

export function AdminDisclosure({
  label = "查看说明",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <details className="mt-2 text-xs leading-6 text-[#595959]">
      <summary className="w-fit cursor-pointer rounded-sm text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#491060]">
        {label}
      </summary>
      <div className="mt-2 space-y-1">{children}</div>
    </details>
  );
}
