use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};

use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

const OPEN_API_HTTP_METHODS: [&str; 8] = [
    "get",
    "put",
    "post",
    "delete",
    "patch",
    "head",
    "options",
    "trace",
];

const OPEN_API_PARAMETER_LOCATIONS: [&str; 4] = ["path", "query", "header", "cookie"];

#[derive(Serialize, Clone)]
struct OpenApiToolParameter {
    name: String,
    location: String,
    required: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OpenApiToolRequestBody {
    required: bool,
    content_types: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OpenApiInvocationPayload {
    method: String,
    path_template: String,
    parameters: Vec<OpenApiToolParameter>,
    request_body: Option<OpenApiToolRequestBody>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DiscoveryTypingPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    input_schema_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_schema_json: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ref_hint_keys: Option<Vec<String>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OpenApiExtractedTool {
    tool_id: String,
    name: String,
    description: Option<String>,
    method: String,
    path: String,
    invocation: OpenApiInvocationPayload,
    operation_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    typing: Option<DiscoveryTypingPayload>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenApiToolManifest {
    version: u8,
    source_hash: String,
    tools: Vec<OpenApiExtractedTool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ref_hint_table: Option<BTreeMap<String, String>>,
}

pub fn extract_manifest_json(
    source_name: &str,
    openapi_document_text: &str,
    pretty: bool,
) -> Result<String, String> {
    let spec = parse_openapi_document(openapi_document_text)?;
    let manifest = extract_openapi_manifest(source_name, &spec)?;

    if pretty {
        serde_json::to_string_pretty(&manifest).map_err(|error| format!("serialize manifest: {error}"))
    } else {
        serde_json::to_string(&manifest).map_err(|error| format!("serialize manifest: {error}"))
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn extract_manifest_json_wasm(
    source_name: &str,
    openapi_document_text: &str,
) -> Result<String, JsValue> {
    extract_manifest_json(source_name, openapi_document_text, false)
        .map_err(|error| JsValue::from_str(&error))
}

fn parse_openapi_document(input: &str) -> Result<Value, String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("OpenAPI document is empty".to_string());
    }

    match serde_json::from_str::<Value>(text) {
        Ok(value) => Ok(value),
        Err(_) => serde_yaml::from_str::<Value>(text)
            .map_err(|error| format!("Unable to parse OpenAPI document as JSON or YAML: {error}")),
    }
}

fn as_object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn as_trimmed_string(value: Option<&Value>) -> Option<String> {
    let candidate = value?.as_str()?.trim();
    if candidate.is_empty() {
        return None;
    }

    Some(candidate.to_string())
}

fn response_status_rank(status_code: &str) -> i32 {
    if status_code.len() == 3
        && status_code.starts_with('2')
        && status_code.chars().all(|character| character.is_ascii_digit())
    {
        return 0;
    }

    if status_code == "default" {
        return 1;
    }

    2
}

fn to_stable_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(to_stable_value).collect()),
        Value::Object(object) => {
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort();

            let mut stable = Map::new();
            for key in keys {
                if let Some(item) = object.get(key) {
                    stable.insert(key.clone(), to_stable_value(item));
                }
            }

            Value::Object(stable)
        }
        Value::Number(number) => {
            if let Some(float_value) = number.as_f64()
                && float_value.is_finite()
                && float_value.fract() == 0.0
            {
                if float_value >= 0.0 && float_value <= u64::MAX as f64 {
                    let unsigned = float_value as u64;
                    if unsigned as f64 == float_value {
                        return Value::Number(serde_json::Number::from(unsigned));
                    }
                }

                if float_value >= i64::MIN as f64 && float_value <= i64::MAX as f64 {
                    let signed = float_value as i64;
                    if signed as f64 == float_value {
                        return Value::Number(serde_json::Number::from(signed));
                    }
                }
            }

            Value::Number(number.clone())
        }
        _ => value.clone(),
    }
}

fn hash_unknown(value: &Value) -> Result<String, String> {
    let stable_json =
        serde_json::to_string(&to_stable_value(value)).map_err(|error| format!("hash json: {error}"))?;

    let mut hasher = Sha256::new();
    hasher.update(stable_json.as_bytes());
    Ok(format!("{:x}", hasher.finalize()))
}

fn encode_stable_json(value: &Value) -> Result<String, String> {
    serde_json::to_string(&to_stable_value(value)).map_err(|error| format!("encode stable json: {error}"))
}

fn to_extracted_tool_parameter(value: &Value) -> Option<OpenApiToolParameter> {
    let record = as_object(value)?;
    let name = record.get("name")?.as_str()?.trim();

    if name.is_empty() {
        return None;
    }

    let location = record.get("in")?.as_str()?;
    if !OPEN_API_PARAMETER_LOCATIONS.contains(&location) {
        return None;
    }

    let required = location == "path" || record.get("required").and_then(Value::as_bool) == Some(true);

    Some(OpenApiToolParameter {
        name: name.to_string(),
        location: location.to_string(),
        required,
    })
}

fn merge_parameters(path_item: &Map<String, Value>, operation: &Map<String, Value>) -> Vec<OpenApiToolParameter> {
    let mut by_key: HashMap<String, OpenApiToolParameter> = HashMap::new();

    let mut add_parameters = |candidate: Option<&Value>| {
        let Some(items) = candidate.and_then(Value::as_array) else {
            return;
        };

        for item in items {
            if let Some(parameter) = to_extracted_tool_parameter(item) {
                by_key.insert(
                    format!("{}:{}", parameter.location, parameter.name),
                    parameter,
                );
            }
        }
    };

    add_parameters(path_item.get("parameters"));
    add_parameters(operation.get("parameters"));

    let mut merged: Vec<OpenApiToolParameter> = by_key.into_values().collect();
    merged.sort_by(|left, right| {
        left.location
            .cmp(&right.location)
            .then_with(|| left.name.cmp(&right.name))
    });
    merged
}

fn extract_request_body(operation: &Map<String, Value>) -> Option<OpenApiToolRequestBody> {
    let request_body = as_object(operation.get("requestBody")?)?;
    let content = request_body.get("content").and_then(as_object);

    let mut content_types = content
        .map(|object| object.keys().cloned().collect::<Vec<String>>())
        .unwrap_or_default();
    content_types.sort();

    Some(OpenApiToolRequestBody {
        required: request_body.get("required").and_then(Value::as_bool) == Some(true),
        content_types,
    })
}

fn build_invocation_metadata(
    method: &str,
    path_value: &str,
    path_item: &Map<String, Value>,
    operation: &Map<String, Value>,
) -> OpenApiInvocationPayload {
    OpenApiInvocationPayload {
        method: method.to_string(),
        path_template: path_value.to_string(),
        parameters: merge_parameters(path_item, operation),
        request_body: extract_request_body(operation),
    }
}

fn collect_ref_keys(value: &Value, refs: &mut BTreeSet<String>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_ref_keys(item, refs);
            }
        }
        Value::Object(record) => {
            if let Some(reference) = record.get("$ref").and_then(Value::as_str)
                && reference.starts_with("#/")
            {
                refs.insert(reference.to_string());
            }

            for nested in record.values() {
                collect_ref_keys(nested, refs);
            }
        }
        _ => {}
    }
}

fn resolve_json_pointer<'a>(root: &'a Value, pointer: &str) -> Option<&'a Value> {
    if !pointer.starts_with("#/") {
        return None;
    }

    let mut current = root;
    for part in pointer[2..].split('/') {
        let decoded = part.replace("~1", "/").replace("~0", "~");
        let next = current.as_object()?.get(&decoded)?;
        current = next;
    }

    Some(current)
}

fn pick_schema_from_content(content: Option<&Value>) -> Option<Value> {
    let content_record = as_object(content?)?;

    let mut keys: Vec<String> = content_record.keys().cloned().collect();
    keys.sort();

    let mut preferred = Vec::with_capacity(keys.len() + 1);
    preferred.push("application/json".to_string());
    preferred.extend(keys);

    let mut seen = HashSet::new();
    for media_type in preferred {
        if !seen.insert(media_type.clone()) {
            continue;
        }

        let Some(media_type_value) = content_record.get(&media_type).and_then(as_object) else {
            continue;
        };

        if let Some(schema) = media_type_value.get("schema") {
            return Some(schema.clone());
        }
    }

    None
}

fn extract_request_body_schema(operation: &Map<String, Value>) -> Option<Value> {
    let request_body = as_object(operation.get("requestBody")?)?;
    pick_schema_from_content(request_body.get("content"))
}

fn extract_response_schema(operation: &Map<String, Value>) -> Option<Value> {
    let responses = as_object(operation.get("responses")?)?;
    let mut response_codes: Vec<String> = responses.keys().cloned().collect();
    response_codes.sort_by(|left, right| {
        response_status_rank(left)
            .cmp(&response_status_rank(right))
            .then_with(|| left.cmp(right))
    });

    for response_code in response_codes {
        let Some(response) = responses.get(&response_code).and_then(as_object) else {
            continue;
        };

        let schema = pick_schema_from_content(response.get("content"));
        if schema.is_some() {
            return schema;
        }
    }

    None
}

fn collect_parameter_schema_by_key(
    path_item: &Map<String, Value>,
    operation: &Map<String, Value>,
) -> HashMap<String, Value> {
    let mut schemas = HashMap::new();

    let mut add_parameters = |candidate: Option<&Value>| {
        let Some(items) = candidate.and_then(Value::as_array) else {
            return;
        };

        for item in items {
            let Some(item_record) = as_object(item) else {
                continue;
            };

            let Some(parameter) = to_extracted_tool_parameter(item) else {
                continue;
            };

            let Some(schema) = item_record.get("schema") else {
                continue;
            };

            schemas.insert(
                format!("{}:{}", parameter.location, parameter.name),
                schema.clone(),
            );
        }
    };

    add_parameters(path_item.get("parameters"));
    add_parameters(operation.get("parameters"));

    schemas
}

fn build_input_schema(
    path_item: &Map<String, Value>,
    operation: &Map<String, Value>,
    invocation: &OpenApiInvocationPayload,
) -> Option<Value> {
    let parameter_schema_by_key = collect_parameter_schema_by_key(path_item, operation);

    let mut properties = Map::new();
    let mut required = BTreeSet::new();

    for parameter in &invocation.parameters {
        let key = format!("{}:{}", parameter.location, parameter.name);
        let schema = parameter_schema_by_key
            .get(&key)
            .cloned()
            .unwrap_or_else(|| json!({ "type": "string" }));

        properties.insert(parameter.name.clone(), schema);

        if parameter.required {
            required.insert(parameter.name.clone());
        }
    }

    let request_body_schema = extract_request_body_schema(operation);
    if let Some(schema) = request_body_schema {
        properties.insert("body".to_string(), schema);

        if invocation
            .request_body
            .as_ref()
            .map(|request_body| request_body.required)
            == Some(true)
        {
            required.insert("body".to_string());
        }
    }

    if properties.is_empty() {
        return None;
    }

    let required_list: Vec<String> = required.into_iter().collect();

    Some(json!({
        "type": "object",
        "properties": properties,
        "required": required_list,
        "additionalProperties": false,
    }))
}

fn build_tool_typing(
    path_item: &Map<String, Value>,
    operation: &Map<String, Value>,
    invocation: &OpenApiInvocationPayload,
) -> Result<Option<DiscoveryTypingPayload>, String> {
    let input_schema = build_input_schema(path_item, operation, invocation);
    let output_schema = extract_response_schema(operation);

    if input_schema.is_none() && output_schema.is_none() {
        return Ok(None);
    }

    let mut refs = BTreeSet::new();
    if let Some(schema) = &input_schema {
        collect_ref_keys(schema, &mut refs);
    }

    if let Some(schema) = &output_schema {
        collect_ref_keys(schema, &mut refs);
    }

    let ref_hint_keys = if refs.is_empty() {
        None
    } else {
        Some(refs.into_iter().collect())
    };

    Ok(Some(DiscoveryTypingPayload {
        input_schema_json: input_schema
            .as_ref()
            .map(encode_stable_json)
            .transpose()?,
        output_schema_json: output_schema
            .as_ref()
            .map(encode_stable_json)
            .transpose()?,
        ref_hint_keys,
    }))
}

fn build_ref_hint_table(open_api_spec: &Value, initial_ref_keys: &[String]) -> Result<BTreeMap<String, String>, String> {
    let mut queue = VecDeque::new();
    let mut queued = HashSet::new();

    for ref_key in initial_ref_keys {
        if queued.insert(ref_key.clone()) {
            queue.push_back(ref_key.clone());
        }
    }

    let mut seen = HashSet::new();
    let mut table = BTreeMap::new();

    while let Some(ref_key) = queue.pop_front() {
        if !seen.insert(ref_key.clone()) {
            continue;
        }

        let Some(resolved) = resolve_json_pointer(open_api_spec, &ref_key) else {
            continue;
        };

        table.insert(ref_key.clone(), encode_stable_json(resolved)?);

        let mut nested = BTreeSet::new();
        collect_ref_keys(resolved, &mut nested);
        for nested_ref in nested {
            if !seen.contains(&nested_ref) {
                queue.push_back(nested_ref);
            }
        }
    }

    Ok(table)
}

fn normalize_path_for_tool_id(path_value: &str) -> String {
    let trimmed = path_value.trim();
    let no_leading = trimmed.strip_prefix('/').unwrap_or(trimmed);

    let mut normalized = String::new();
    let mut last_was_underscore = false;

    for character in no_leading.chars() {
        if character.is_ascii_alphanumeric() {
            normalized.push(character);
            last_was_underscore = false;
            continue;
        }

        if !last_was_underscore {
            normalized.push('_');
            last_was_underscore = true;
        }
    }

    let without_edges = normalized.trim_matches('_').to_lowercase();
    if without_edges.is_empty() {
        return "root".to_string();
    }

    without_edges
}

fn build_tool_id(method: &str, path_value: &str, operation: &Map<String, Value>) -> String {
    if let Some(operation_id) = as_trimmed_string(operation.get("operationId")) {
        return operation_id;
    }

    format!("{}_{}", method, normalize_path_for_tool_id(path_value))
}

fn build_tool_name(method: &str, path_value: &str, operation: &Map<String, Value>) -> String {
    if let Some(summary) = as_trimmed_string(operation.get("summary")) {
        return summary;
    }

    if let Some(operation_id) = as_trimmed_string(operation.get("operationId")) {
        return operation_id;
    }

    format!("{} {}", method.to_uppercase(), path_value)
}

fn build_tool_description(operation: &Map<String, Value>) -> Option<String> {
    as_trimmed_string(operation.get("description")).or_else(|| as_trimmed_string(operation.get("summary")))
}

fn ensure_unique_tool_ids(source_name: &str, tools: &[OpenApiExtractedTool]) -> Result<(), String> {
    let mut seen = HashSet::new();

    for tool in tools {
        if !seen.insert(tool.tool_id.clone()) {
            return Err(format!(
                "OpenAPI extraction failed for '{source_name}': duplicate toolId {} ({})",
                tool.tool_id,
                tool.path
            ));
        }
    }

    Ok(())
}

fn extract_openapi_manifest(source_name: &str, openapi_spec: &Value) -> Result<OpenApiToolManifest, String> {
    let spec_record = as_object(openapi_spec)
        .ok_or_else(|| format!("OpenAPI extraction failed for '{source_name}': spec must be object"))?;

    let Some(paths) = spec_record.get("paths").and_then(as_object) else {
        return Ok(OpenApiToolManifest {
            version: 1,
            source_hash: hash_unknown(openapi_spec)?,
            tools: Vec::new(),
            ref_hint_table: None,
        });
    };

    let mut path_keys: Vec<String> = paths.keys().cloned().collect();
    path_keys.sort();

    let mut tools = Vec::new();

    for path_value in path_keys {
        let Some(path_item) = paths.get(&path_value).and_then(as_object) else {
            continue;
        };

        for method in OPEN_API_HTTP_METHODS {
            let Some(operation) = path_item.get(method).and_then(as_object) else {
                continue;
            };

            let invocation = build_invocation_metadata(method, &path_value, path_item, operation);
            let typing = build_tool_typing(path_item, operation, &invocation)?;

            let operation_hash_input = json!({
                "method": method,
                "path": path_value,
                "operation": operation,
                "invocation": invocation,
            });

            tools.push(OpenApiExtractedTool {
                tool_id: build_tool_id(method, &path_value, operation),
                name: build_tool_name(method, &path_value, operation),
                description: build_tool_description(operation),
                method: method.to_string(),
                path: path_value.clone(),
                invocation,
                operation_hash: hash_unknown(&operation_hash_input)?,
                typing,
            });
        }
    }

    tools.sort_by(|left, right| {
        left.tool_id
            .to_lowercase()
            .cmp(&right.tool_id.to_lowercase())
            .then_with(|| left.tool_id.cmp(&right.tool_id))
    });
    ensure_unique_tool_ids(source_name, &tools)?;

    let direct_ref_keys: Vec<String> = tools
        .iter()
        .flat_map(|tool| {
            tool.typing
                .as_ref()
                .and_then(|typing| typing.ref_hint_keys.clone())
                .unwrap_or_default()
        })
        .collect();

    let ref_hint_table = build_ref_hint_table(openapi_spec, &direct_ref_keys)?;

    Ok(OpenApiToolManifest {
        version: 1,
        source_hash: hash_unknown(openapi_spec)?,
        tools,
        ref_hint_table: if ref_hint_table.is_empty() {
            None
        } else {
            Some(ref_hint_table)
        },
    })
}
