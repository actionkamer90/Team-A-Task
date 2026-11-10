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
