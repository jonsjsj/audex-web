"""EPUB -> Readium Web Publication Manifest (RWPM), parsed in-house.

None of the @readium/* npm packages include a browser-side EPUB parser: @readium/shared
only MODELS an already-parsed Publication (a Manifest you hand it, plus a Fetcher that
serves already-extracted resources by URL) and @readium/navigator only renders one.
Turning a raw .epub file into that shape — unzip, read container.xml -> the OPF package
document -> build readingOrder/toc — is traditionally the streamer's job (r2-streamer-js
in Node, or a native streamer in the mobile SDKs). There's no Python equivalent, so this
does the same job: unzip with stdlib zipfile, parse container.xml + the OPF with stdlib
xml.etree (both are small, well-formed XML docs — no need for lxml), and emit RWPM JSON
matching https://readium.org/webpub-manifest/ that Manifest.deserialize() on the frontend
consumes directly.

Deliberately does NOT implement EPUB2 guide, page-list, or encryption (Adobe DRM etc.) —
out of scope for a personal ABS library. NCX (EPUB2) and nav.xhtml (EPUB3) TOC are both
handled since ABS libraries commonly mix both formats' books.
"""
from __future__ import annotations

import io
import posixpath
import zipfile
from dataclasses import dataclass, field
from xml.etree import ElementTree as ET

OPF_NS = "http://www.idpf.org/2007/opf"
DC_NS = "http://purl.org/dc/elements/1.1/"
CONTAINER_NS = "urn:oasis:names:tc:opendocument:xmlns:container"
XHTML_NS = "http://www.w3.org/1999/xhtml"
EPUB_OPS_NS = "http://www.idpf.org/2007/ops"
NCX_NS = "http://www.daisy.org/z3986/2005/ncx/"

# EPUB2 media-types aren't always accurate (some packagers write text/html for
# XHTML content docs) — normalise both to the RWPM/Readium-expected value so
# the navigator's frame renderer recognises them as reflowable content.
_XHTML_LIKE = {"application/xhtml+xml", "text/html", "application/html"}


class EpubError(Exception):
    """The file isn't a well-formed EPUB, or is missing a piece this parser
    requires (container.xml, an OPF rootfile, a manifest). Callers surface
    this as a 502/422 rather than a stack trace."""


@dataclass
class ManifestItem:
    href: str  # zip-internal path, already resolved relative to the OPF's directory
    media_type: str


@dataclass
class TocEntry:
    title: str
    href: str  # zip-internal path (+ optional #fragment)
    children: list["TocEntry"] = field(default_factory=list)


@dataclass
class ParsedEpub:
    zf: zipfile.ZipFile
    manifest: dict[str, ManifestItem]  # OPF item id -> item
    spine_order: list[str]  # OPF item ids, in reading order
    title: str
    authors: list[str]
    toc: list[TocEntry]

    def read(self, zip_path: str) -> bytes:
        try:
            return self.zf.read(zip_path)
        except KeyError:
            raise EpubError(f"Resource not found in EPUB: {zip_path}")

    def media_type_for(self, zip_path: str) -> str | None:
        for item in self.manifest.values():
            if item.href == zip_path:
                return item.media_type
        return None


def _qn(ns: str, tag: str) -> str:
    return f"{{{ns}}}{tag}"


def _resolve(base_dir: str, href: str) -> str:
    """[href] as written in the OPF/NCX/nav is relative to the file that
    references it, and may contain '../'. normpath collapses that; POSIX
    join because zip entries always use '/' regardless of host OS."""
    return posixpath.normpath(posixpath.join(base_dir, href)) if base_dir else posixpath.normpath(href)


def parse_epub(data: bytes) -> ParsedEpub:
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise EpubError("Not a valid EPUB (not a zip file).")

    try:
        container_xml = zf.read("META-INF/container.xml")
    except KeyError:
        raise EpubError("Not a valid EPUB (missing META-INF/container.xml).")
    try:
        container = ET.fromstring(container_xml)
    except ET.ParseError as e:
        raise EpubError(f"Malformed container.xml: {e}")

    rootfile = container.find(f".//{_qn(CONTAINER_NS, 'rootfile')}")
    opf_path = rootfile.get("full-path") if rootfile is not None else None
    if not opf_path:
        raise EpubError("EPUB container.xml has no rootfile full-path.")
    opf_dir = posixpath.dirname(opf_path)

    try:
        opf = ET.fromstring(zf.read(opf_path))
    except KeyError:
        raise EpubError(f"container.xml points at a missing OPF: {opf_path}")
    except ET.ParseError as e:
        raise EpubError(f"Malformed OPF package document: {e}")

    title = "Untitled"
    authors: list[str] = []
    metadata_el = opf.find(_qn(OPF_NS, "metadata"))
    if metadata_el is not None:
        title_el = metadata_el.find(_qn(DC_NS, "title"))
        if title_el is not None and title_el.text and title_el.text.strip():
            # Readium's Metadata.deserialize() treats a falsy `title` as "not
            # a valid manifest" and returns undefined — a whitespace-only
            # <dc:title> must not win over the "Untitled" default.
            title = title_el.text.strip()
        for creator_el in metadata_el.findall(_qn(DC_NS, "creator")):
            if creator_el.text and creator_el.text.strip():
                authors.append(creator_el.text.strip())

    manifest: dict[str, ManifestItem] = {}
    nav_id: str | None = None
    ncx_id: str | None = None
    manifest_el = opf.find(_qn(OPF_NS, "manifest"))
    if manifest_el is not None:
        for item in manifest_el.findall(_qn(OPF_NS, "item")):
            item_id, href, media_type = item.get("id"), item.get("href"), item.get("media-type", "")
            if not item_id or not href:
                continue
            zip_path = _resolve(opf_dir, href)
            if media_type in _XHTML_LIKE:
                media_type = "application/xhtml+xml"
            manifest[item_id] = ManifestItem(href=zip_path, media_type=media_type)
            if "nav" in (item.get("properties") or "").split():
                nav_id = item_id
            if media_type == "application/x-dtbncx+xml":
                ncx_id = item_id

    spine_order: list[str] = []
    spine_el = opf.find(_qn(OPF_NS, "spine"))
    if spine_el is not None:
        for itemref in spine_el.findall(_qn(OPF_NS, "itemref")):
            idref = itemref.get("idref")
            if idref and idref in manifest and itemref.get("linear", "yes") != "no":
                spine_order.append(idref)
    if not spine_order:
        raise EpubError("EPUB spine is empty — nothing to read.")

    toc = _parse_toc(zf, manifest, nav_id, ncx_id)
    if not toc:
        # No nav/NCX (rare, but some hand-built EPUB2s omit it) — fall back to
        # one flat entry per spine item so the reader still has SOME TOC.
        toc = [
            TocEntry(title=f"Chapter {i + 1}", href=manifest[item_id].href)
            for i, item_id in enumerate(spine_order)
        ]

    return ParsedEpub(zf=zf, manifest=manifest, spine_order=spine_order, title=title, authors=authors, toc=toc)


def _parse_toc(
    zf: zipfile.ZipFile, manifest: dict[str, ManifestItem], nav_id: str | None, ncx_id: str | None,
) -> list[TocEntry]:
    if nav_id and nav_id in manifest:
        entries = _parse_nav_toc(zf, manifest[nav_id].href)
        if entries:
            return entries
    if ncx_id and ncx_id in manifest:
        entries = _parse_ncx_toc(zf, manifest[ncx_id].href)
        if entries:
            return entries
    return []


def _parse_nav_toc(zf: zipfile.ZipFile, nav_href: str) -> list[TocEntry]:
    """EPUB3 nav document: <nav epub:type="toc"><ol><li><a href=...>Title</a>
    <ol>...nested...</ol></li></ol></nav>."""
    try:
        doc = ET.fromstring(zf.read(nav_href))
    except (KeyError, ET.ParseError):
        return []
    nav_dir = posixpath.dirname(nav_href)
    toc_nav = None
    for nav in doc.iter(_qn(XHTML_NS, "nav")):
        if nav.get(_qn(EPUB_OPS_NS, "type")) == "toc":
            toc_nav = nav
            break
    if toc_nav is None:
        return []
    top_ol = toc_nav.find(_qn(XHTML_NS, "ol"))
    return _parse_nav_ol(top_ol, nav_dir) if top_ol is not None else []


def _parse_nav_ol(ol: ET.Element, base_dir: str) -> list[TocEntry]:
    entries = []
    for li in ol.findall(_qn(XHTML_NS, "li")):
        child_ol = li.find(_qn(XHTML_NS, "ol"))
        children = _parse_nav_ol(child_ol, base_dir) if child_ol is not None else []
        a = li.find(_qn(XHTML_NS, "a"))
        if a is not None and a.get("href"):
            title = "".join(a.itertext()).strip() or "Untitled"
            entries.append(TocEntry(title=title, href=_resolve(base_dir, a.get("href")), children=children))
        elif children:
            # A heading-only <li> (a <span>, not an <a>) grouping a nested
            # <ol> — a common EPUB3 nav pattern for unlinked part/section
            # headers ("Part One" over chapters 1-3). It has no href of its
            # own to point the TOC entry at, so promote its children to this
            # level instead of dropping the whole subtree because the parent
            # wasn't clickable.
            entries.extend(children)
    return entries


def _parse_ncx_toc(zf: zipfile.ZipFile, ncx_href: str) -> list[TocEntry]:
    """EPUB2 NCX: <navMap><navPoint><navLabel><text>Title</text></navLabel>
    <content src=.../><navPoint>...nested...</navPoint></navPoint></navMap>."""
    try:
        doc = ET.fromstring(zf.read(ncx_href))
    except (KeyError, ET.ParseError):
        return []
    ncx_dir = posixpath.dirname(ncx_href)
    nav_map = doc.find(_qn(NCX_NS, "navMap"))
    return _parse_nav_points(nav_map, ncx_dir) if nav_map is not None else []


def _parse_nav_points(parent: ET.Element, base_dir: str) -> list[TocEntry]:
    entries = []
    for point in parent.findall(_qn(NCX_NS, "navPoint")):
        label = point.find(f"{_qn(NCX_NS, 'navLabel')}/{_qn(NCX_NS, 'text')}")
        content = point.find(_qn(NCX_NS, "content"))
        src = content.get("src") if content is not None else None
        if not src:
            continue
        title = (label.text or "").strip() if label is not None and label.text else "Untitled"
        entries.append(TocEntry(
            title=title, href=_resolve(base_dir, src), children=_parse_nav_points(point, base_dir),
        ))
    return entries


def _toc_to_rwpm(entries: list[TocEntry]) -> list[dict]:
    out = []
    for e in entries:
        link: dict = {"href": e.href, "title": e.title}
        if e.children:
            link["children"] = _toc_to_rwpm(e.children)
        out.append(link)
    return out


def build_manifest(pub: ParsedEpub, self_url: str) -> dict:
    """RWPM JSON — see https://readium.org/webpub-manifest/. Every href here is
    a plain zip-relative path (e.g. "OEBPS/chapter1.xhtml"), NOT prefixed with
    the resource route — @readium/shared's HttpFetcher.get() resolves a Link's
    href against ITS OWN baseUrl via WHATWG URL resolution (Link.toURL()), so
    baking the resource-route prefix into the href here as well would double
    it (…/res/api/read/x/res/OEBPS/chapter1.xhtml). The frontend passes that
    prefix once, as HttpFetcher's own baseUrl constructor argument, instead.
    [self_url] is this manifest's own URL, for the `self` link Manifest reads
    its .baseURL from — unrelated to, and NOT joined through, HttpFetcher."""
    reading_order = [
        {"href": pub.manifest[item_id].href, "type": pub.manifest[item_id].media_type}
        for item_id in pub.spine_order
    ]
    resources = [
        {"href": item.href, "type": item.media_type}
        for item_id, item in pub.manifest.items()
        if item_id not in pub.spine_order
    ]
    return {
        "@context": "https://readium.org/webpub-manifest/context.jsonld",
        "metadata": {
            "title": pub.title,
            "author": pub.authors,  # Contributors.deserialize accepts a bare array of strings
        },
        "links": [{"href": self_url, "rel": "self", "type": "application/webpub+json"}],
        "readingOrder": reading_order,
        "resources": resources,
        "toc": _toc_to_rwpm(pub.toc),
    }
