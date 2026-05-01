//! Export apicult-desigual geometry as SVG or JSON via the [`SerializeGeo`] trait.
//!
//! ```sh
//! cargo run --example geo_export                                # plain SVG
//! cargo run --example geo_export -- 5 2.0                       # plain SVG, custom radius/pad
//! cargo run --example geo_export -- 5 2.0 --format svg-rich     # rich SVG
//! cargo run --example geo_export -- 5 2.0 --format json-v1      # gen1 JSON
//! cargo run --example geo_export -- --seed 7                    # override height-noise seed
//! ```

use std::io::{self, Write};

use apicult_desigual::{HGridLayout, HGridSettings, JsonV1, SerializeGeo, SvgPlain, SvgRich};

fn main() {
    let mut positional: Vec<String> = Vec::new();
    let mut format: Option<String> = None;
    let mut seed: Option<u32> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--seed" => match args.next().and_then(|s| s.parse().ok()) {
                Some(s) => seed = Some(s),
                None => {
                    eprintln!("--seed requires a u32 value");
                    std::process::exit(2);
                }
            },
            "--format" => match args.next() {
                Some(f) => format = Some(f),
                None => {
                    eprintln!("--format requires a value (svg, svg-rich, json-v1)");
                    std::process::exit(2);
                }
            },
            _ => positional.push(arg),
        }
    }
    let radius: u32 = positional.first().and_then(|s| s.parse().ok()).unwrap_or(3);
    let pad: f32 = positional
        .get(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(4.0);

    let defaults = HGridSettings::default();
    let settings = HGridSettings {
        radius,
        height_noise_seed: seed.unwrap_or(defaults.height_noise_seed),
        nominal_hex_radius: 4.0,
        ..defaults
    };
    let layout = HGridLayout::new(&settings, &[], &[]);

    let stdout = io::stdout();
    let mut out = stdout.lock();
    let result = match format.as_deref().unwrap_or("svg") {
        "svg" | "svg-plain" => SvgPlain { pad }.write(&layout, &mut out),
        "svg-rich" => SvgRich { pad }.write(&layout, &mut out),
        "json-v1" => JsonV1.write(&layout, &mut out),
        other => {
            eprintln!("unknown format '{other}' (expected svg, svg-rich, json-v1)");
            std::process::exit(2);
        }
    };
    if let Err(e) = result.and_then(|_| out.flush()) {
        eprintln!("write failed: {e}");
        std::process::exit(1);
    }
}
