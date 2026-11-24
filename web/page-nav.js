/**
 * Shared page switcher for the demo pages: a `<select>` listing every page,
 * mounted into each `[data-page-nav]` element. Pages load it as its own
 * `<script type="module">`, so the nav still works when a page's main module
 * fails to load.
 */

/** Every published page, in nav order. `href` is the deployed file name. */
export const PAGES = [
  { href: "index.html",       label: "welded terrain"  },
  { href: "hex-units.html",   label: "hex units"       },
  { href: "hex-crawler.html", label: "hex crawler"     },
  { href: "hex-stream.html",  label: "chunk treadmill" },
  { href: "svg-preview.html", label: "grid preview"    },
  { href: "guide.html",       label: "geometry guide"  },
];

/**
 * The nav's options for the page at `pathname`.
 * @param {string} pathname `location.pathname`; a trailing `/` means `index.html`.
 * @returns {{href: string, label: string, selected: boolean}[]}
 */
export const pageOptions = (pathname) => {
  const file = pathname.split("/").pop() || "index.html";
  return PAGES.map((p) => ({ ...p, selected: p.href === file }));
};

/**
 * Replace `el`'s contents with the page `<select>`; choosing an entry navigates.
 * @param {HTMLElement} el
 * @param {string} [pathname]
 */
export function mountPageNav(el, pathname = location.pathname) {
  const select = document.createElement("select");
  select.className = "page-nav";
  select.setAttribute("aria-label", "demo pages");
  select.append(...pageOptions(pathname).map(({ href, label, selected }) =>
    new Option(label, href, selected, selected)));
  select.addEventListener("change", () => { location.href = select.value; });
  el.replaceChildren(select);
}

if (typeof document !== "undefined") {
  document.querySelectorAll("[data-page-nav]").forEach((el) => mountPageNav(el));
}
