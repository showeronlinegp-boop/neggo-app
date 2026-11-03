"""Normaliza el teléfono del registro público antes de guardarlo en el contacto."""

MAX_PHONE_LENGTH = 64


class SignupPhoneError(ValueError):
    """El teléfono del formulario no se puede guardar."""


def clean_signup_phone(raw):
    """Devuelve el valor a escribir en res.partner.phone.

    Vacío no es válido: el registro público pide el teléfono.
    No reformatea el número; solo recorta espacios y rechaza un texto enorme.
    """
    phone = str(raw or '').strip()
    if not phone:
        raise SignupPhoneError('Ingresá un teléfono.')
    if len(phone) > MAX_PHONE_LENGTH:
        raise SignupPhoneError('El teléfono es demasiado largo.')
    return phone
