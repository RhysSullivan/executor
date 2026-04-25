import { ClaudeCode, OpenCode, Codex } from "@lobehub/icons";

function PiLogo({ size = 24 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 800 800"
      width={size}
      height={size}
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
      />
      <path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>
  );
}

export default function HarnessLogos() {
  return (
    <div className="flex flex-col items-center gap-6 mt-14">
      <p className="text-[14px] text-[#999] tracking-[-0.01em]">
        Use in your favorite harness
      </p>
      <div className="flex items-center gap-10 text-[#333]">
        <ClaudeCode.Color size={32} />
        <OpenCode.Text size={20} />
        <Codex.Color size={32} />
        <PiLogo size={28} />
      </div>
    </div>
  );
}
