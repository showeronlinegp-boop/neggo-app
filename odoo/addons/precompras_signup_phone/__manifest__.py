{
    'name': 'Teléfono en el registro del sitio',
    'version': '19.0.1.0.0',
    'category': 'Website',
    'summary': 'Pide el teléfono al registrarse y lo guarda en el contacto',
    'depends': ['website', 'auth_signup'],
    'data': [
        'views/signup_templates.xml',
    ],
    'installable': True,
    'license': 'LGPL-3',
}
