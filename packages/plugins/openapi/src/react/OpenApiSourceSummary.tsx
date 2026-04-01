export default function OpenApiSourceSummary(props: {
  sourceId: string;
}) {
  return (
    <span>
      OpenAPI · {props.sourceId}
    </span>
  );
}
