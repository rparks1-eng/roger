"""Regression fixtures are entirely synthetic. No course files or credentials."""

import importlib.util
import io
from pathlib import Path
import unittest
import warnings
import zipfile

spec = importlib.util.spec_from_file_location(
    "presentation", Path(__file__).resolve().parents[1] / "src/python/presentation.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE = "http://schemas.openxmlformats.org/package/2006/relationships"


def files(text="Hello &amp; goodbye", p=P, a=A, r=R):
    return {
        "ppt/presentation.xml": '<x:presentation xmlns:x="%s" xmlns:z="%s"><x:sldIdLst><x:sldId id="1" z:id="rId1"/></x:sldIdLst></x:presentation>'
        % (p, r),
        "ppt/_rels/presentation.xml.rels": '<Relationships xmlns="%s"><Relationship Id="rId1" Type="%s/slide" Target="slides/slide1.xml"/></Relationships>'
        % (PACKAGE, r),
        "ppt/slides/slide1.xml": '<x:sld xmlns:x="%s" xmlns:d="%s"><d:p><d:r><d:t>%s</d:t></d:r><d:br/><d:r><d:t>Next</d:t></d:r></d:p></x:sld>'
        % (p, a, text),
    }


def archive(entries=None, compression=zipfile.ZIP_DEFLATED):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=compression) as package:
        for name, value in (entries or files()).items():
            package.writestr(name, value)
    return output.getvalue()


class PresentationTests(unittest.TestCase):
    def assert_error(self, data, code=None):
        with self.assertRaises(module.PresentationError) as raised:
            module.extract_presentation(data)
        if code:
            self.assertEqual(str(raised.exception), code)

    def test_stored_deflated_and_alternate_namespace_prefixes(self):
        for compression in [zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED]:
            result = module.extract_presentation(archive(compression=compression))
            self.assertEqual(result["pages"], [{"page": 1, "text": "Hello & goodbye\nNext"}])
            self.assertEqual(result["layout"], "text-only")

    def test_strict_office_namespaces(self):
        entries = files(
            p="http://purl.oclc.org/ooxml/presentationml/main",
            a="http://purl.oclc.org/ooxml/drawingml/main",
            r="http://purl.oclc.org/ooxml/officeDocument/relationships",
        )
        self.assertEqual(len(module.extract_presentation(archive(entries))["pages"]), 1)

    def test_package_absolute_target_and_unsafe_targets(self):
        entries = files()
        key = "ppt/_rels/presentation.xml.rels"
        entries[key] = entries[key].replace(
            'Target="slides/slide1.xml"', 'Target="/ppt/slides/slide1.xml"'
        )
        self.assertEqual(len(module.extract_presentation(archive(entries))["pages"]), 1)
        for target in ["../slide1.xml", "/etc/passwd", "slides/../../secret", "file:///etc/passwd"]:
            entries = files()
            entries[key] = entries[key].replace("slides/slide1.xml", target)
            self.assert_error(archive(entries), "slides")

    def test_bad_zip_and_input_size(self):
        self.assert_error(b"bad", "damaged")
        self.assert_error(b"", "input")
        self.assert_error(b"x" * (module.MAX_BYTES + 1), "input")

    def test_no_path_traversal_or_absolute_names(self):
        for name in ["../escape", "/absolute", "a/../b", "a\\b", "C:/escape"]:
            entries = files()
            entries[name] = "untrusted"
            self.assert_error(archive(entries), "archive")

    def test_duplicate_names_and_excessive_entry_count(self):
        output = io.BytesIO()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            with zipfile.ZipFile(output, "w") as package:
                package.writestr("same", "one")
                package.writestr("same", "two")
        self.assert_error(output.getvalue(), "archive")
        self.assert_error(archive({"part%d" % i: "" for i in range(2049)}), "archive")

    def test_compression_xml_and_total_expansion_budgets(self):
        entries = files()
        entries["ppt/slides/slide1.xml"] = "x" * (module.MAX_XML + 1)
        self.assert_error(archive(entries), "archive")
        self.assert_error(archive(compression=zipfile.ZIP_BZIP2), "archive")
        # Repeated small compressed members test the declared total without
        # allocating or decompressing a 64 MiB payload.
        entries = files()
        entries.update({"blob%d" % i: "x" * (512 * 1024) for i in range(129)})
        self.assert_error(archive(entries), "archive")

    def test_declarations_external_relations_and_bad_xml(self):
        entries = files()
        entries["ppt/slides/slide1.xml"] = (
            '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x/>'
        )
        self.assert_error(archive(entries), "xml")
        entries = files()
        entries["ppt/_rels/presentation.xml.rels"] = (
            '<Relationships xmlns="%s"><Relationship Id="rId1" Type="%s/slide" Target="https://example.com" TargetMode="External"/></Relationships>'
            % (PACKAGE, R)
        )
        self.assert_error(archive(entries), "slides")
        entries = files()
        entries["ppt/slides/slide1.xml"] = "<unclosed>"
        self.assert_error(archive(entries), "damaged")

    def test_crc_damage_is_rejected(self):
        data = archive(compression=zipfile.ZIP_STORED)
        self.assert_error(data.replace(b"Hello &amp; goodbye", b"Jello &amp; goodbye"), "damaged")

    def test_utf16_character_budget_and_missing_slide(self):
        self.assert_error(archive(files("😀" * 60_001)), "text")
        entries = files()
        del entries["ppt/slides/slide1.xml"]
        self.assert_error(archive(entries), "missing")


if __name__ == "__main__":
    unittest.main()
