import unittest
from visemes import make_timeline

class VisemeTimelineTests(unittest.TestCase):
    def test_respects_real_word_windows_and_silence(self):
        words = [
            {"offset": 10_000_000, "duration": 4_000_000, "text": "白貓"},
            {"offset": 20_000_000, "duration": 3_000_000, "text": "跑"},
        ]
        timeline = make_timeline(words)
        self.assertTrue(timeline)
        allowed = {"closed", "aa", "ih", "ou", "ee", "oh"}
        for event in timeline:
            self.assertIn(event["shape"], allowed)
            self.assertLess(event["start"], event["end"])
            self.assertTrue((1 <= event["start"] < event["end"] <= 1.40001)
                            or (2 <= event["start"] < event["end"] <= 2.30001))
        self.assertEqual(timeline[0]["start"], 1.)
        self.assertAlmostEqual(timeline[-1]["end"], 2.3)
        for previous, current in zip(timeline, timeline[1:]):
            self.assertLessEqual(previous["end"], current["start"] + .00001)

    def test_bilabial_consonants_begin_closed(self):
        for text in ("白", "跑", "媽"):
            timeline = make_timeline([{"offset": 0, "duration": 3_000_000, "text": text}])
            self.assertEqual(timeline[0]["shape"], "closed")
            self.assertGreater(timeline[0]["end"], .04)
            self.assertTrue(any(event["shape"] != "closed" for event in timeline))

    def test_five_vowels_and_empty_input(self):
        timeline = make_timeline([{"offset": 0, "duration": 20_000_000, "text": "啊衣烏鵝喔"}])
        self.assertTrue({"aa", "ih", "ou", "ee", "oh"}.issubset({event["shape"] for event in timeline}))
        self.assertEqual(make_timeline([]), [])
        self.assertEqual(make_timeline([{"offset": 0, "duration": 0, "text": "你好"}]), [])

if __name__ == '__main__':
    unittest.main()
