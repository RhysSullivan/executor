export function ErrorMessage(props: { message: string; small?: boolean; spacious?: boolean }) {
  return (
    <div className={`rounded-lg border border-destructive/30 bg-destructive/5 ${props.spacious ? "px-4 py-3" : "px-3 py-2"}`}>
      <p className={`${props.small ? "text-[12px]" : "text-sm"} text-destructive`}>{props.message}</p>
    </div>
  );
}
