//! Export apicult-desigual geometry as SVG or JSON via the [`SerializeGeo`] trait.
//!
//! ```sh
//! cargo run --example geo_export                                # plain SVG
//! cargo run --example geo_export -- 5 2.0                       # plain SVG, custom radius/pad
//! cargo run --example geo_export -- 5 2.0 --format svg-rich     # rich SVG
//! cargo run --example geo_export -- 5 2.0 --format json-v1      # gen1 JSON
//! cargo run --example geo_export -- --seed 7                    # override height-noise seed
//! cargo run --example geo_export -- --radius-seed 9             # override radius-noise seed
//! ```

use std::io::{self, Write};

use apicult_desigual::{HGridLayout, HGridSettings, JsonV1, SerializeGeo, SvgPlain, SvgRich};

fn main() {
    let mut positional: Vec<String> = Vec::new();
    let mut format: Option<String> = None;
    let mut seed: Option<u32> = None;
    let mut radius_seed: Option<u32> = None;
    let mut args = std::env::args().skip(1);
    let u32_flag = |flag: &str, value: Option<String>| -> u32 {
        value.and_then(|s| s.parse().ok()).unwrap_or_else(|| {
            eprintln!("{flag} requires a u32 value");
            std::process::exit(2);
        })
    };
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--seed" => seed = Some(u32_flag("--seed", args.next())),
            "--radius-seed" => radius_seed = Some(u32_flag("--radius-seed", args.next())),
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

    let mut settings = HGridSettings {
        nominal_hex_radius: 4.0,
        ..HGridSettings::default()
    };
    if let Some(seed) = seed {
        settings.height_noise.seed = seed;
    }
    if let Some(seed) = radius_seed {
        settings.radius_noise.seed = seed;
    }
    let layout = HGridLayout::new(&settings, radius, &[], &[]);

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
