use std::fs;
use std::io::{self, Read, Write};

use clap::Parser;

#[derive(Parser, Debug)]
#[command(name = "openapi-extractor-rs")]
struct Cli {
    #[arg(long)]
    source_name: String,
    #[arg(long)]
    input: String,
    #[arg(long)]
    output: Option<String>,
    #[arg(long, default_value_t = false)]
    pretty: bool,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = Cli::parse();
    let source_text = read_input_text(&args.input)?;

    let output_json =
        openapi_extractor_rs::extract_manifest_json(&args.source_name, &source_text, args.pretty)?;

    if let Some(path) = args.output {
        fs::write(path, output_json).map_err(|error| format!("write output file: {error}"))?;
    } else {
        let mut stdout = io::stdout().lock();
        stdout
            .write_all(output_json.as_bytes())
            .map_err(|error| format!("write stdout: {error}"))?;
        stdout
            .write_all(b"\n")
            .map_err(|error| format!("write stdout newline: {error}"))?;
    }

    Ok(())
}

fn read_input_text(input: &str) -> Result<String, String> {
    if input == "-" {
        let mut buffer = String::new();
        io::stdin()
            .read_to_string(&mut buffer)
            .map_err(|error| format!("read stdin: {error}"))?;
        return Ok(buffer);
    }

    fs::read_to_string(input).map_err(|error| format!("read input file '{input}': {error}"))
}
