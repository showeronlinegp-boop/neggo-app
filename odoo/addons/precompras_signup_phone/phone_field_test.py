"""Prueba de la normalización del teléfono, sin levantar Odoo."""
import unittest

from phone_field import MAX_PHONE_LENGTH, SignupPhoneError, clean_signup_phone


class CleanSignupPhoneTest(unittest.TestCase):

    def test_strips_spaces(self):
        self.assertEqual(clean_signup_phone('  2477 15 123456  '), '2477 15 123456')

    def test_keeps_plus_and_dashes(self):
        self.assertEqual(clean_signup_phone('+54 9 2477-123456'), '+54 9 2477-123456')

    def test_rejects_empty(self):
        for raw in (None, '', '   '):
            with self.assertRaises(SignupPhoneError):
                clean_signup_phone(raw)

    def test_rejects_too_long(self):
        with self.assertRaises(SignupPhoneError):
            clean_signup_phone('1' * (MAX_PHONE_LENGTH + 1))

    def test_accepts_max_length(self):
        raw = '1' * MAX_PHONE_LENGTH
        self.assertEqual(clean_signup_phone(raw), raw)


if __name__ == '__main__':
    unittest.main()
