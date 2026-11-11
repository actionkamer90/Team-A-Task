"""Minimal .xlsx writer (standard library only): inline strings, numbers, dates, percentages,
bold header row, frozen header, column widths and an autofilter."""
import datetime as dt
import io
import re
import zipfile
from xml.sax.saxutils import escape

_BAD = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f]")


class Date:
    def __init__(self, iso):
        self.iso = iso


class Sheet:
    def __init__(self, name, rows, widths=None, formats=None, bold_rows=None):
        self.name = re.sub(r"[\[\]:*?/\\]", "", name)[:31]
        self.rows, self.widths, self.formats, self.bold_rows = rows, widths or [], formats or {}, bold_rows or set()


def col(n):
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


# style ids: 0 default, 1 bold header, 2 date, 3 percent, 4 bold, 5 bold percent, 6 wrap text
STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFD9ECEF"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="9" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>"""


def _serial(iso):
    d = dt.date.fromisoformat(iso)
    return (d - dt.date(1899, 12, 30)).days


def _sheet_xml(sh):
    out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">']
    ncols = max([len(r) for r in sh.rows] + [1])
    nrows = max(len(sh.rows), 1)
    out.append('<dimension ref="A1:%s%d"/>' % (col(ncols - 1), nrows))
    out.append('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
               '</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>')
    if sh.widths:
        out.append("<cols>" + "".join('<col min="%d" max="%d" width="%s" customWidth="1"/>' % (i + 1, i + 1, w)
                                      for i, w in enumerate(sh.widths)) + "</cols>")
    out.append("<sheetData>")
    for ri, row in enumerate(sh.rows):
        cells = []
        for ci, v in enumerate(row):
            ref = "%s%d" % (col(ci), ri + 1)
            bold = ri == 0 or ri in sh.bold_rows
            if v is None or (isinstance(v, Date) and not v.iso) or v == "":
                continue
            if isinstance(v, Date):
                cells.append('<c r="%s" s="2"><v>%d</v></c>' % (ref, _serial(v.iso)))
            elif isinstance(v, bool):
                cells.append('<c r="%s" t="b"><v>%d</v></c>' % (ref, int(v)))
            elif isinstance(v, (int, float)):
                pct = sh.formats.get(ci) == "pct" and ri > 0
                s = (5 if bold else 3) if pct else (4 if bold and ri else 0)
                cells.append('<c r="%s"%s><v>%s</v></c>' % (ref, ' s="%d"' % s if s else "", repr(float(v)) if isinstance(v, float) else v))
            else:
                txt = escape(_BAD.sub("", str(v)))
                s = 1 if ri == 0 else 4 if bold else 6 if "\n" in txt else 0
                cells.append('<c r="%s" t="inlineStr"%s><is><t xml:space="preserve">%s</t></is></c>' % (ref, ' s="%d"' % s if s else "", txt))
        out.append('<row r="%d">%s</row>' % (ri + 1, "".join(cells)))
    out.append("</sheetData>")
    if len(sh.rows) > 1:
        out.append('<autoFilter ref="A1:%s%d"/>' % (col(ncols - 1), nrows))
    out.append('<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>')
    return "".join(out)


def _defined_names(sheets):
    names = "".join('<definedName name="_xlnm._FilterDatabase" localSheetId="%d" hidden="1">\'%s\'!$A$1:$%s$%d</definedName>'
                    % (i, escape(s.name.replace("'", "''")), col(max(len(r) for r in s.rows) - 1), len(s.rows))
                    for i, s in enumerate(sheets) if len(s.rows) > 1)
    return "<definedNames>%s</definedNames>" % names if names else ""


def build(sheets):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        n = len(sheets)
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                   '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                   + "".join('<Override PartName="/xl/worksheets/sheet%d.xml" '
                             'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' % (i + 1) for i in range(n))
                   + "</Types>")
        z.writestr("_rels/.rels",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
                   'Target="xl/workbook.xml"/></Relationships>')
        z.writestr("xl/workbook.xml",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                   'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
                   + "".join('<sheet name="%s" sheetId="%d" r:id="rId%d"/>' % (escape(s.name, {'"': "&quot;"}), i + 1, i + 1)
                             for i, s in enumerate(sheets))
                   + "</sheets>" + _defined_names(sheets) + "</workbook>")
        z.writestr("xl/_rels/workbook.xml.rels",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   + "".join('<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
                             'Target="worksheets/sheet%d.xml"/>' % (i + 1, i + 1) for i in range(n))
                   + '<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
                     'Target="styles.xml"/></Relationships>' % (n + 1))
        z.writestr("xl/styles.xml", STYLES)
        for i, s in enumerate(sheets):
            z.writestr("xl/worksheets/sheet%d.xml" % (i + 1), _sheet_xml(s))
    return buf.getvalue()


# ---------------------------------------------------------------- free-form sheets (e.g. the project timeline)
class Cell:
    """A value with its own look. fill/color are hex like "1F7A99"; align is "left", "center" or "right"."""

    def __init__(self, v, bold=False, fill=None, color=None, align=None, wrap=False, border=False, date=False, pct=False, size=None, italic=False):
        self.v, self.bold, self.fill, self.color, self.align, self.wrap = v, bold, fill, color, align, wrap
        self.border, self.date, self.pct, self.size, self.italic = border, date, pct, size, italic

    def key(self):
        return (self.bold, self.fill, self.color, self.align, self.wrap, self.border, self.date, self.pct, self.size, self.italic)


class GridSheet:
    """cells: {(row, col): Cell} with 0-based row/col. merges: [(r1, c1, r2, c2)]. freeze: (rows, cols) kept visible."""

    def __init__(self, name, cells, widths=None, merges=None, freeze=None, heights=None):
        self.name = re.sub(r"[\[\]:*?/\\]", "", name)[:31]
        self.cells, self.widths, self.merges, self.freeze, self.heights = cells, widths or {}, merges or [], freeze, heights or {}


class _Styles:
    def __init__(self):
        self.fonts, self.fills, self.xfs = [("0", None, 11, False)], ["none", "gray125"], [None]
        self.index = {}

    def xf(self, c):
        if not isinstance(c, Cell):
            return 0
        k = c.key()
        if k == (False, None, None, None, False, False, False, False, None, False):
            return 0
        if k not in self.index:
            font = (("1" if c.bold else "0"), c.color, c.size or 11, c.italic)
            if font not in self.fonts:
                self.fonts.append(font)
            fill = c.fill or "none"
            if fill not in self.fills:
                self.fills.append(fill)
            self.xfs.append((self.fonts.index(font), self.fills.index(fill), c))
            self.index[k] = len(self.xfs) - 1
        return self.index[k]

    def xml(self):
        fonts = "".join("<font>%s%s<sz val=\"%s\"/>%s<name val=\"Calibri\"/><family val=\"2\"/></font>"
                        % ("<b/>" if b == "1" else "", "<i/>" if it else "", sz, '<color rgb="FF%s"/>' % col_ if col_ else "")
                        for b, col_, sz, it in self.fonts)
        fills = "".join('<fill><patternFill patternType="%s"/></fill>' % f if f in ("none", "gray125") else
                        '<fill><patternFill patternType="solid"><fgColor rgb="FF%s"/><bgColor indexed="64"/></patternFill></fill>' % f
                        for f in self.fills)
        thin = '<left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right>' \
               '<top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/>'
        xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>']
        for x in self.xfs[1:]:
            fo, fi, c = x
            num = 164 if c.date else 9 if c.pct else 0
            al = ""
            if c.align or c.wrap:
                al = '<alignment%s vertical="center"%s/>' % (' horizontal="%s"' % c.align if c.align else "", ' wrapText="1"' if c.wrap else "")
            xfs.append('<xf numFmtId="%d" fontId="%d" fillId="%d" borderId="%d" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"%s>%s</xf>'
                       % (num, fo, fi, 1 if c.border else 0, ' applyAlignment="1"' if al else "", al))
        return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd-mmm-yy"/></numFmts>'
                '<fonts count="%d">%s</fonts><fills count="%d">%s</fills>'
                '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border>%s</border></borders>'
                '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
                '<cellXfs count="%d">%s</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
                '</styleSheet>' % (len(self.fonts), fonts, len(self.fills), fills, thin, len(xfs), "".join(xfs)))


def _grid_xml(sh, st):
    nr = max([r for r, _ in sh.cells] + [0]) + 1
    nc = max([c for _, c in sh.cells] + [0]) + 1
    out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
           '<dimension ref="A1:%s%d"/>' % (col(nc - 1), nr)]
    if sh.freeze:
        fr, fc = sh.freeze
        out.append('<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane%s%s topLeftCell="%s%d" activePane="bottomRight" state="frozen"/>'
                   '</sheetView></sheetViews>' % (' xSplit="%d"' % fc if fc else "", ' ySplit="%d"' % fr if fr else "", col(fc), fr + 1))
    else:
        out.append('<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>')
    out.append('<sheetFormatPr defaultRowHeight="15"/>')
    if sh.widths:
        out.append("<cols>" + "".join('<col min="%d" max="%d" width="%s" customWidth="1"/>' % (c + 1, c + 1, w)
                                      for c, w in sorted(sh.widths.items())) + "</cols>")
    out.append("<sheetData>")
    rows = {}
    for (r, c), cell in sh.cells.items():
        rows.setdefault(r, []).append((c, cell))
    for r in sorted(rows):
        cells = []
        for c, cell in sorted(rows[r]):
            ref = "%s%d" % (col(c), r + 1)
            s = st.xf(cell)
            sa = ' s="%d"' % s if s else ""
            v = cell.v if isinstance(cell, Cell) else cell
            if v is None or v == "":
                if s:
                    cells.append('<c r="%s"%s/>' % (ref, sa))
            elif isinstance(cell, Cell) and cell.date:
                cells.append('<c r="%s"%s><v>%d</v></c>' % (ref, sa, _serial(v)))
            elif isinstance(v, bool):
                cells.append('<c r="%s" t="b"%s><v>%d</v></c>' % (ref, sa, int(v)))
            elif isinstance(v, (int, float)):
                cells.append('<c r="%s"%s><v>%s</v></c>' % (ref, sa, repr(float(v)) if isinstance(v, float) else v))
            else:
                cells.append('<c r="%s" t="inlineStr"%s><is><t xml:space="preserve">%s</t></is></c>' % (ref, sa, escape(_BAD.sub("", str(v)))))
        ht = sh.heights.get(r)
        out.append('<row r="%d"%s>%s</row>' % (r + 1, ' ht="%s" customHeight="1"' % ht if ht else "", "".join(cells)))
    out.append("</sheetData>")
    if sh.merges:
        out.append('<mergeCells count="%d">%s</mergeCells>' % (len(sh.merges), "".join(
            '<mergeCell ref="%s%d:%s%d"/>' % (col(c1), r1 + 1, col(c2), r2 + 1) for r1, c1, r2, c2 in sh.merges)))
    out.append('<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>'
               '<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>')
    return "".join(out)


def build_grid(sheets):
    """Workbook of GridSheets with their own fills, fonts, borders, merges and frozen panes. Values only, no formulas."""
    st = _Styles()
    bodies = [_grid_xml(s, st) for s in sheets]  # collects the styles used
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        n = len(sheets)
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                   '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                   + "".join('<Override PartName="/xl/worksheets/sheet%d.xml" '
                             'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' % (i + 1) for i in range(n))
                   + "</Types>")
        z.writestr("_rels/.rels",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
                   'Target="xl/workbook.xml"/></Relationships>')
        z.writestr("xl/workbook.xml",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                   'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
                   + "".join('<sheet name="%s" sheetId="%d" r:id="rId%d"/>' % (escape(s.name, {'"': "&quot;"}), i + 1, i + 1)
                             for i, s in enumerate(sheets))
                   + "</sheets></workbook>")
        z.writestr("xl/_rels/workbook.xml.rels",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   + "".join('<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
                             'Target="worksheets/sheet%d.xml"/>' % (i + 1, i + 1) for i in range(n))
                   + '<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
                     'Target="styles.xml"/></Relationships>' % (n + 1))
        z.writestr("xl/styles.xml", st.xml())
        for i, b in enumerate(bodies):
            z.writestr("xl/worksheets/sheet%d.xml" % (i + 1), b)
    return buf.getvalue()
