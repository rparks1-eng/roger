"""Pure domain regressions. No filesystem corpus, credentials or provider calls."""

from pathlib import Path
import base64
import io
import sys
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/python"))
from common import DomainError, units, cut
import retrieval
import study
import study_sets
import canvas_records as canvas
import syllabus


class SyllabusTests(unittest.TestCase):
    def test_html_keeps_visible_course_links_and_ignores_script_text(self):
        result = syllabus.run(
            "syllabus.html",
            {
                "html": '<p><a href="/courses/1/files/2" title="Syllabus.pdf">Read</a></p>'
                "<script>Office hours: invented</script><h3>Office hours</h3><p>By appointment</p>"
            },
        )
        self.assertEqual(result["links"][0]["title"], "Syllabus.pdf")
        self.assertIn("By appointment", result["evidence"]["officeHours"][0]["excerpt"])
        self.assertNotIn("invented", result["text"])

    def test_grading_weights_outrank_contents_and_cite_the_pdf_page(self):
        result = syllabus.excerpts(
            [
                {"page": 1, "text": "O ff ice Hours: Wednesday 1:30 PM\nGrading 6"},
                {"page": 6, "text": "Grading and Course Deliverables\nGroup project 30%\nExam 70%"},
            ]
        )
        self.assertEqual([item["page"] for item in result["grading"]], [6])
        self.assertEqual(result["officeHours"][0]["page"], 1)

    def test_docx_preserves_separation_between_assignment_and_weight(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(
                "word/document.xml",
                '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                "<w:body><w:p><w:r><w:t>Assessment</w:t></w:r></w:p>"
                "<w:p><w:r><w:t>Exam #1</w:t><w:tab/><w:t>20%</w:t></w:r></w:p></w:body></w:document>",
            )
        result = syllabus.run(
            "syllabus.docx", {"archive": base64.b64encode(data.getvalue()).decode()}
        )
        self.assertEqual(result["evidence"]["grading"][0]["excerpt"], "Assessment\nExam #1  20%")
        self.assertIsNone(result["evidence"]["grading"][0]["page"])


def doc(text, **changes):
    return dict(id="one", revision="1", title="Synthetic reading", text=text, **changes)


class StudySetTests(unittest.TestCase):
    def test_empty_ranking_batch_can_continue_but_empty_final_set_rejects(self):
        value = dict(
            mode="flashcards",
            engine="quick",
            sources=[dict(id="a", kind="material", text="Vocabulary")],
        )
        self.assertEqual(study_sets.prepare(value, allow_empty=True)["passages"], [])
        with self.assertRaises(DomainError):
            study_sets.prepare(value)

    def test_focus_finds_later_source_and_late_paragraph_text(self):
        sources = [
            dict(
                id=f"source-{i}",
                kind="material",
                text=f"Practice reading number {i} introduces ordinary material.",
            )
            for i in range(40)
        ]
        sources.append(
            dict(
                id="source-99",
                kind="material",
                text="Ordinary course introduction. " * 100
                + "The zephyr coefficient quantifies nonlinear retrieval performance.",
            )
        )
        result = study_sets.prepare(
            dict(mode="flashcards", engine="quick", sources=sources, focus="zephyr coefficient")
        )
        self.assertEqual(result["passages"][0]["sourceId"], "source-99")
        self.assertIn("zephyr coefficient", result["passages"][0]["quote"])

    def test_multiple_choice_uses_exact_answers_and_distinct_alternatives(self):
        sources = [
            dict(id="a", kind="assignment", text="The presentation is worth 20%."),
            dict(id="s", kind="syllabus", text="The final project is worth 50%."),
            dict(id="n", kind="notes", text="The field report is worth 25%."),
            dict(id="m", kind="material", text="The worked example uses a 10% discount rate."),
        ]
        prepared = study_sets.prepare(dict(mode="multiple-choice", engine="quick", sources=sources))
        result = study_sets.build(dict(prepared=prepared, generated=None))
        self.assertEqual({card["sourceId"] for card in result["cards"]}, {"a", "s", "n", "m"})
        for card in result["cards"]:
            self.assertIn("____", card["prompt"])
            self.assertIn(card["answer"], card["quote"])
            self.assertIn(card["answer"], card["options"])
            self.assertEqual(len(card["options"]), len(set(card["options"])))

    def test_true_false_answers_describe_the_cited_text(self):
        prepared = study_sets.prepare(
            dict(
                mode="true-false",
                engine="quick",
                sources=[
                    dict(
                        id="m",
                        kind="material",
                        text="The report uses a 10% discount rate. The example uses a 20% discount rate.",
                    )
                ],
            )
        )
        cards = study_sets.build(dict(prepared=prepared, generated=None))["cards"]
        self.assertEqual([card["answer"] for card in cards], ["True", "False"])
        self.assertIn("“10%”", cards[0]["prompt"])
        self.assertIn("“10%”", cards[1]["prompt"])
        self.assertIn("20%", cards[1]["quote"])
        self.assertTrue(all(card["options"] == ["True", "False"] for card in cards))

    def test_multiple_choice_rejects_a_source_without_a_distractor(self):
        prepared = study_sets.prepare(
            dict(
                mode="multiple-choice",
                engine="quick",
                sources=[dict(id="m", kind="material", text="The final project is worth 50%.")],
            )
        )
        with self.assertRaises(DomainError):
            study_sets.build(dict(prepared=prepared, generated=None))

    def test_exact_citations_and_source_coverage(self):
        prepared = study_sets.prepare(
            dict(
                mode="practice",
                engine="local",
                sources=[
                    dict(
                        id="a",
                        kind="assignment",
                        text="Include a project summary in the presentation.",
                    ),
                    dict(id="s", kind="syllabus", text="The project is worth 50% of the grade."),
                    dict(id="n", kind="notes", text="My example uses three illustrated slides."),
                ],
            )
        )
        result = study_sets.build(
            dict(
                prepared=prepared,
                generated=dict(
                    cards=[
                        dict(prompt="What is the project weight?", answer="50%", ref="p2"),
                        dict(prompt="How many diagrams?", answer="five", ref="p3"),
                        dict(prompt="Which color?", answer="blue", ref="p999"),
                    ]
                ),
            )
        )
        self.assertEqual(result["enhanced"], 1)
        self.assertEqual({card["sourceId"] for card in result["cards"]}, {"a", "s", "n"})
        self.assertNotIn("five", str(result))
        self.assertTrue(all(card["answer"] in card["quote"] for card in result["cards"]))

    def test_worksheet_only_compares_verified_percentages_from_one_source(self):
        text = "The sample has a 15.25% rate and a 4% rate, with an invalid -2% and 105%."
        sources = [
            dict(id="a", kind="assignment", text="The other assignment counts for 40%."),
            dict(id="m", kind="material", text=text),
        ]
        prepared = study_sets.prepare(dict(mode="worksheet", engine="quick", sources=sources))
        result = study_sets.build(dict(prepared=prepared, generated=None))
        self.assertEqual(
            result["worksheet"]["rows"],
            [
                dict(sourceId="m", quote=text, value=15.25),
                dict(sourceId="m", quote=text, value=4),
            ],
        )
        sources[1]["text"] = "This unrelated course assessment counts for 10%."
        prepared = study_sets.prepare(dict(mode="worksheet", engine="quick", sources=sources))
        self.assertIsNone(study_sets.build(dict(prepared=prepared, generated=None))["worksheet"])

    def test_discussion_prompt_contains_a_cited_excerpt_and_rubric(self):
        text = "The case describes two teams testing alternative approaches."
        prepared = study_sets.prepare(
            dict(
                mode="discussion",
                engine="quick",
                sources=[dict(id="m", kind="material", text=text)],
            )
        )
        card = study_sets.build(dict(prepared=prepared, generated=None))["cards"][0]
        self.assertEqual((card["sourceId"], card["quote"]), ("m", text))
        self.assertIn("what claim", card["prompt"].lower())
        self.assertIn("quote one specific detail", card["answer"])
        self.assertFalse(card["generated"])


class RetrievalTests(unittest.TestCase):
    def test_unicode_offsets_and_source_identity(self):
        first, second = "😀 Café e\u0301vidence\n\n", "βήτα 日本語 chair\n\n"
        text = first + second
        result = retrieval.search(
            dict(
                documents=[
                    doc(
                        text,
                        pages=[
                            dict(page=1, start=0, end=units(first)),
                            dict(page=2, start=units(first), end=units(text)),
                        ],
                    )
                ],
                query="chair",
            )
        )
        self.assertEqual(result["passages"][0]["start"], units(first))
        self.assertEqual(result["passages"][0]["page"], 2)
        self.assertEqual(
            cut(text, result["passages"][0]["start"], result["passages"][0]["end"]), second
        )
        self.assertEqual(result["evidenceText"], second)

    def test_overlap_results_and_stable_ties(self):
        text = "chair " * 1000
        result = retrieval.search(dict(documents=[doc(text)], query="chair"))
        for i, passage in enumerate(result["passages"]):
            self.assertEqual(passage["text"], cut(text, passage["start"], passage["end"]))
            for other in result["passages"][:i]:
                self.assertFalse(
                    other["start"] < passage["end"] and passage["start"] < other["end"]
                )
        self.assertEqual(result["passages"][0]["start"], 0)
        self.assertLessEqual(len(result["passages"]), 4)

    def test_no_match_empty_and_stop_words(self):
        for query in ["volcano", "the and what"]:
            self.assertEqual(
                retrieval.search(dict(documents=[doc("chair")], query=query))["state"], "no-match"
            )
        self.assertEqual(retrieval.search(dict(documents=[], query="chair"))["passages"], [])

    def test_limits_duplicate_sources_and_no_paths(self):
        values = [
            dict(documents=[doc("chair")] * 2, query="chair"),
            dict(documents=["/etc/passwd"], query="chair"),
            dict(documents=[doc("x" * 120001)], query="chair"),
            dict(documents=[], query="x" * 3001),
            dict(documents=[], query=""),
            dict(documents=[], query="chair", path="/etc/passwd"),
        ]
        for value in values:
            with self.assertRaises(DomainError):
                retrieval.search(value)
        with self.assertRaisesRegex(DomainError, "oversized"):
            retrieval.search(
                dict(
                    documents=[
                        dict(id=str(i), revision="1", title="Reading", text="x" * 100000)
                        for i in range(5)
                    ],
                    query="chair",
                )
            )

    def test_page_gaps_overlap_booleans_and_trailing_text(self):
        for pages in [
            [dict(page=True, start=0, end=5)],
            [dict(page=1, start=1, end=5)],
            [dict(page=1, start=0, end=2)],
            [dict(page=1, start=0, end=3), dict(page=2, start=2, end=5)],
        ]:
            with self.assertRaises(DomainError):
                retrieval.create_index([doc("chair", pages=pages)])

    def test_surrogate_boundary_matches_browser_slicing(self):
        text = "a" * 1199 + "😀 chair"
        index = retrieval.create_index([doc(text)])
        self.assertEqual(units(index["passages"][0]["text"]), 1200)
        self.assertEqual(index["passages"][0]["text"][-1], "\ud83d")
        self.assertEqual(index["passages"][1]["start"], 1040)


class StudyTests(unittest.TestCase):
    def test_routes_do_not_escalate(self):
        self.assertEqual(
            study.route(dict(task="application", hasEvidence=False))["kind"], "application"
        )
        self.assertEqual(
            study.route(dict(task="interpretation", hasEvidence=False))["kind"], "needs-evidence"
        )
        self.assertEqual(
            study.route(dict(task="interpretation", hasEvidence=True, provider="codex"))["kind"],
            "needs-consent",
        )
        self.assertEqual(
            study.route(dict(task="interpretation", hasEvidence=True))["provider"], "ollama"
        )
        with self.assertRaises(DomainError):
            study.route(dict(task="interpretation", hasEvidence=1))

    def test_input_budgets_consent_and_unknown_fields(self):
        for value in [
            dict(text="chair", message="why", provider="codex"),
            dict(text="", message="why"),
            dict(text="chair", message="why", allowCloud=1),
            dict(text="chair", message="why", command="ls"),
            dict(text="x" * 24000, message="why"),
        ]:
            with self.assertRaises(DomainError):
                study.prepare(value)
        result = study.prepare(dict(text="chair", message=" why "))
        self.assertEqual(result["message"], "why")
        self.assertIn("untrusted data", result["system"])

    def test_exact_quotes_and_followup(self):
        value = dict(
            reply="It suggests absence.",
            question="What does the door suggest?",
            passages=[dict(quote="invented", note="unsupported")],
        )
        self.assertEqual(
            study.validate(
                dict(value=value, source="The empty chair", message="What does the chair suggest?")
            )["passages"],
            [],
        )
        value["passages"][0]["quote"] = "empty chair"
        self.assertEqual(
            len(
                study.validate(dict(value=value, source="The empty chair", message="Why?"))[
                    "passages"
                ]
            ),
            1,
        )

    def test_schema_html_word_limits_and_repeat_rejection(self):
        base = dict(
            reply="It suggests absence.", question="What does the door suggest?", passages=[]
        )
        for change in [
            dict(extra=True),
            dict(reply="word " * 101),
            dict(reply="<script>bad</script>"),
            dict(question="Why?"),
            dict(question="word " * 31),
            dict(passages=[dict(quote="x", note="y", path="private")]),
        ]:
            with self.assertRaises(DomainError):
                study.validate(dict(value={**base, **change}, source="x", message="Why?"))


class CanvasTests(unittest.TestCase):
    def test_identifiers_strip_markup_and_boolean_points(self):
        self.assertEqual(
            canvas.normalize("canvas.profile", dict(raw=dict(id=12.0, name="<b>Student</b>"))),
            dict(id="12", name="Student"),
        )
        with self.assertRaises(DomainError):
            canvas.identifier(True)
        with self.assertRaises(DomainError):
            canvas.identifier("١٢")
        self.assertIsNone(canvas.assignment(dict(id=2, points_possible=True), "1")["points"])

    def test_assignment_identity_and_utf16_description(self):
        raw = dict(
            id=2,
            course_id=1,
            description="😀" * 60001,
            can_submit=False,
            submission=dict(workflow_state="submitted", attempt=2),
        )
        result = canvas.normalize(
            "canvas.assignment", dict(raw=raw, courseId="1", assignmentId="2")
        )["assignment"]
        self.assertEqual(units(result["descriptionHtml"]), 120000)
        self.assertTrue(result["descriptionTruncated"])
        self.assertTrue(result["submitted"])
        self.assertFalse(result["canSubmit"])
        with self.assertRaises(DomainError):
            canvas.normalize("canvas.assignment", dict(raw=raw, courseId="9", assignmentId="2"))

    def test_locked_pages_and_untrusted_html_remains_data(self):
        with self.assertRaisesRegex(DomainError, "locked"):
            canvas.normalize("canvas.page", dict(courseId="1", raw=dict(locked_for_user=True)))
        html = "<h1>Course</h1><script>never execute</script>"
        self.assertEqual(
            canvas.normalize("canvas.page", dict(courseId="1", raw=dict(body=html)))["page"][
                "bodyHtml"
            ],
            html,
        )

    def test_modules_and_missing_submission_fields(self):
        value = dict(
            raw=dict(id=1, name="Course"),
            courseId="1",
            assignments=[dict(id=2)],
            modules=[dict(id=3, state="locked", items=[dict(id=4, type="File", content_id=5)])],
        )
        result = canvas.normalize("canvas.course", value)
        self.assertTrue(result["modules"][0]["locked"])
        self.assertEqual(result["modules"][0]["items"][0]["fileId"], "5")
        self.assertEqual(result["assignments"][0]["submissionTypes"], [])


if __name__ == "__main__":
    unittest.main()
