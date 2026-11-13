from odoo.addons.auth_signup.controllers.main import AuthSignupHome
from odoo.addons.web.controllers.home import SIGN_UP_REQUEST_PARAMS
from odoo.exceptions import UserError
from odoo.http import request

from ..phone_field import SignupPhoneError, clean_signup_phone

# Sin esto, get_auth_signup_qcontext descarta el POST y el teléfono no llega
# ni a la plantilla ni a _prepare_signup_values.
SIGN_UP_REQUEST_PARAMS.add('phone')


def _is_public_signup():
    """El reset de contraseña también llama do_signup y no trae teléfono."""
    path = (request.httprequest.path or '').rstrip('/')
    return path.endswith('/web/signup')


class AuthSignupHomePhone(AuthSignupHome):

    def _prepare_signup_values(self, qcontext):
        values = super()._prepare_signup_values(qcontext)
        if not _is_public_signup():
            return values
        try:
            # res.users.phone es related a res.partner.phone (readonly=False).
            # res.users.signup() copia el usuario plantilla con estos valores
            # y así queda escrito en el contacto.
            values['phone'] = clean_signup_phone(qcontext.get('phone'))
        except SignupPhoneError as err:
            raise UserError(str(err)) from err
        return values
