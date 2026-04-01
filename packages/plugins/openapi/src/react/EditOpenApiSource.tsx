export default function EditOpenApiSource(props: {
  sourceId: string;
  onSave: () => void;
}) {
  return (
    <div>
      <h3>Edit OpenAPI Source</h3>
      <p>Source: {props.sourceId}</p>
      {/* TODO: show spec info, auth config, operation list */}
      <button onClick={props.onSave}>Save</button>
    </div>
  );
}
