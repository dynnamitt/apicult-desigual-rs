//! Export one large hex terrain as chunk files plus `manifest.json`.
//! File formats: see the [`apicult_desigual::chunk`] module docs.
//!
//! ```sh
//! cargo run --release --bin hex-chunks -- --out target/chunks
//! cargo run --release --bin hex-chunks -- --out target/chunks --radius 60 --chunk-radius 6 --hex-radius 4.0 --seed 43
//! ```

use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::process::exit;
use std::str::FromStr;

use apicult_desigual::{HGridLayout, HGridSettings, ManifestEntry, partition, write_manifest};

const USAGE: &str =
    "usage: hex-chunks --out <dir> [--radius N] [--chunk-radius N] [--hex-radius F] [--seed N]";

fn value<T: FromStr>(flag: &str, arg: Option<String>) -> T {
    arg.and_then(|s| s.parse().ok()).unwrap_or_else(|| {
        eprintln!("{flag} needs a valid value\n{USAGE}");
        exit(2)
    })
}

fn main() {
    let defaults = HGridSettings::default();
    let mut out: Option<PathBuf> = None;
    let mut settings = HGridSettings {
        radius: 60,
        ..defaults
    };
    let mut chunk_radius: u32 = 6;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--out" => out = Some(value(&arg, args.next())),
            "--radius" => settings.radius = value(&arg, args.next()),
            "--chunk-radius" => chunk_radius = value(&arg, args.next()),
            "--hex-radius" => settings.nominal_hex_radius = value(&arg, args.next()),
            "--seed" => settings.height_noise_seed = value(&arg, args.next()),
            "-h" | "--help" => {
                println!("{USAGE}");
                return;
            }
            other => {
                eprintln!("unknown argument '{other}'\n{USAGE}");
                exit(2)
            }
        }
    }
    let Some(dir) = out else {
        eprintln!("--out is required\n{USAGE}");
        exit(2)
    };
    if let Err(e) = run(&dir, &settings, chunk_radius) {
        eprintln!("hex-chunks: {e}");
        exit(1)
    }
}

fn run(dir: &PathBuf, settings: &HGridSettings, chunk_radius: u32) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let layout = HGridLayout::new(settings, &[], &[]);
    let chunks = partition(&layout, chunk_radius);
    let mut entries = Vec::with_capacity(chunks.len());
    for chunk in &chunks {
        let mut w = BufWriter::new(File::create(dir.join(chunk.file_name()))?);
        let hash = chunk.write(&mut w)?;
        w.flush()?;
        entries.push(ManifestEntry { chunk, hash });
    }
    let mut w = BufWriter::new(File::create(dir.join("manifest.json"))?);
    write_manifest(settings, chunk_radius, &entries, &mut w)?;
    w.flush()?;
    let cells: usize = chunks.iter().map(|c| c.cells.len()).sum();
    eprintln!(
        "wrote {} chunks ({cells} cells) to {}",
        chunks.len(),
        dir.display()
    );
    Ok(())
}
