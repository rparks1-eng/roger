"""Syllabus recommendations must remain traceable and honest about unknown scope."""

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/python"))
from common import DomainError
from exam_plan import plan


def source(key, title, available=True):
    return {
        "key": key,
        "title": title,
        "module": "Course readings",
        "url": "https://babson.instructure.com/courses/1/pages/" + key,
        "available": available,
    }


def payload(text, materials, exam=""):
    return {
        "exam": exam,
        "syllabus": {
            "title": "Course syllabus.pdf",
            "url": "https://babson.instructure.com/courses/1/files/2",
            "pages": [{"page": 4, "text": text}],
        },
        "materials": materials,
    }


class ExamPlanTests(unittest.TestCase):
    def test_chapter_scope_selects_all_matching_materials_and_reports_missing(self):
        text = "Exam 2 covers chapters 4–6. Bring a calculator."
        value = plan(
            payload(
                text,
                [
                    source("a", "Chapter 4 slides"),
                    source("b", "Chapter 5 practice"),
                    source("c", "Chapter 5 video", False),
                    source("d", "Chapter 8 investment"),
                ],
            )
        )
        self.assertEqual(value["selectedKeys"], ["a", "b"])
        self.assertEqual(value["exam"], "exam 2")
        self.assertTrue(any(gap["label"] == "Chapter 6" for gap in value["gaps"]))
        self.assertTrue(any(gap["label"] == "Chapter 5 video" for gap in value["gaps"]))
        self.assertEqual(value["reasons"][0]["citations"][0]["page"], 4)
        self.assertIn(value["reasons"][0]["citations"][0]["quote"], text)

    def test_multiple_exams_require_choice_and_do_not_mix_scopes(self):
        text = "Exam 1 covers chapters 1-3. Exam 2 covers chapters 4 and 5."
        items = [source("a", "Chapter 1 notes"), source("b", "Chapter 4 notes")]
        initial = plan(payload(text, items))
        self.assertEqual(initial["exam"], "")
        self.assertEqual(len(initial["choices"]), 2)
        selected = plan(payload(text, items, "Exam 2"))
        self.assertEqual(selected["selectedKeys"], ["b"])
        self.assertFalse(any("1 covers" in cite["quote"] for cite in selected["scopeCitations"]))

    def test_final_project_weight_is_not_invented_exam_scope(self):
        text = "Final Exam (Individual Project): 40%\n4. Time Value of Money\nWhat you will learn\n5. Bonds"
        result = plan(
            payload(
                text,
                [
                    source("a", "Chapter 4 Time Value of Money"),
                    source("b", "Chapter 5 Bonds"),
                    source("c", "Your weekend reads"),
                ],
            )
        )
        self.assertEqual(result["exam"], "final exam")
        self.assertEqual(len(result["selectedKeys"]), 3)
        self.assertEqual(len(result["courseTopics"]), 2)
        self.assertIn("not confirmed exam scope", result["reasons"][0]["reason"])
        self.assertTrue(any("Exact chapter coverage" in item for item in result["unknowns"]))
        self.assertNotIn("dueAt", result)

    def test_ambiguous_joint_scope_does_not_assign_chapters_to_each_exam(self):
        result = plan(
            payload(
                "Exam 1 and Exam 2 cover chapters 1-8.", [source("a", "Chapter 10 notes")], "exam 2"
            )
        )
        self.assertEqual(result["selectedKeys"], ["a"])
        self.assertTrue(any("Exact chapter coverage" in item for item in result["unknowns"]))

    def test_unknown_exam_and_no_exam_fail_honestly(self):
        result = plan(
            payload("Read all chapters before class.", [source("a", "Chapter 1")], "exam 3")
        )
        self.assertEqual(result["selectedKeys"], [])
        self.assertTrue(any("not identified" in item for item in result["unknowns"]))

    def test_malformed_and_duplicate_materials_are_rejected(self):
        item = source("a", "Chapter 4")
        with self.assertRaises(DomainError):
            plan(payload("Exam 1", [item, item]))
        with self.assertRaises(DomainError):
            plan(payload("x" * 240001, []))


if __name__ == "__main__":
    unittest.main()
