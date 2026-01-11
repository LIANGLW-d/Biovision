import csv
import pathlib
import tempfile
import unittest

from beaver_id.cli import extract_json_object, iter_local_image_paths, write_csv


class TestCli(unittest.TestCase):
    def test_iter_local_image_paths_filters_images(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = pathlib.Path(tmpdir)
            (tmp_path / "a.jpg").write_text("x")
            (tmp_path / "b.txt").write_text("x")
            (tmp_path / "c.PNG").write_text("x")

            paths = [path.name for path in iter_local_image_paths(tmp_path)]

            self.assertEqual(paths, ["a.jpg", "c.PNG"])

    def test_extract_json_object_handles_wrapped_output(self) -> None:
        payload = "Here you go: {\"is_beaver\": true, \"confidence\": 0.7}"
        data = extract_json_object(payload)

        self.assertEqual(data["is_beaver"], True)
        self.assertEqual(data["confidence"], 0.7)

    def test_write_csv_emits_rows(self) -> None:
        rows = [
            {
                "image_path": "img1.jpg",
                "has_beaver": True,
                "confidence": 0.9,
                "reason": "test",
                "bbox": "",
                "model_id": "model-a",
                "error": "",
            },
            {
                "image_path": "img2.jpg",
                "has_beaver": False,
                "confidence": 0.1,
                "reason": "",
                "bbox": "",
                "model_id": "model-a",
                "error": "",
            },
        ]
        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = pathlib.Path(tmpdir) / "out.csv"
            write_csv(rows, output_path)

            with output_path.open("r", newline="") as handle:
                reader = csv.DictReader(handle)
                data = list(reader)

            self.assertEqual(len(data), 2)
            self.assertEqual(data[0]["image_path"], "img1.jpg")
