/**
 * i18n.ts — tiny typed dictionary for the first-run surfaces (en / pt / es / fr).
 * No library, no Electron import: the main process and the renderer bundles
 * both import it (like account-input.ts). The language is chosen once in main
 * (lang.ts) and passed to windows. No plural forms: copy says "Tries left: 3".
 *
 * pt = Brazilian wording, es = neutral Latin American, fr = "vous". The
 * pt/es/fr columns have not been read by a native speaker yet.
 */

export type Lang = 'en' | 'pt' | 'es' | 'fr';

const en = {
  'setup.title': "Let's get you set up",
  'setup.sub': "Enter your email and we'll send a 6-digit code. Clippy is free, no card. Already have an account? Use the same email.",
  'email.label': 'Your email',
  'email.placeholder': 'you@example.com',
  'email.send': 'Send code',
  'email.sending': 'Sending…',
  'email.suggest': 'Did you mean {email}?',
  'email.suggest.yes': 'Yes, fix it',
  'code.label': 'Enter the 6-digit code we sent to {email}',
  'code.hint': 'It can take a minute. Check your spam folder too.',
  'code.continue': 'Continue',
  'code.checking': 'Checking…',
  'code.resend': 'Send a new code',
  'code.resend.wait': 'Send a new code ({s}s)',
  'code.resent': 'New code sent.',
  'code.change': 'Use a different email',
  'code.open.gmail': 'Open Gmail',
  'code.open.outlook': 'Open Outlook',
  'err.invalid_email': "That email doesn't look right. Check it and try again.",
  'err.rate_limited': 'Too many tries. Wait {n} min and try again.',
  'err.rate_limited_day': 'Too many tries today. Try again tomorrow.',
  'err.wrong_code': "That code isn't right. Tries left: {n}.",
  'err.wrong_code_last': 'Too many wrong tries. Click "Send a new code".',
  'err.code_expired': 'That code has expired. Click "Send a new code".',
  'err.offline': "Can't reach the internet. Check your connection and try again.",
  'err.server': 'Something went wrong on our side. Try again in a moment.',
  'key.link': 'I have a license key',
  'key.activate': 'Activate',
  'privacy': 'Clippy reads your screen only to help with what you ask, or to offer a tip (tips can be turned off in Settings → Brain). Screenshots are never stored.',
  'close': 'Close',
  'hello': "Hi, I'm Clippy! Ask me anything. Try one of these:",
  'chip.screen': "What's on my screen?",
  'chip.screen.prompt': 'Summarize what I have on my screen right now.',
  'chip.reply': 'Help me write a reply',
  'chip.reply.prompt': 'Help me write a reply to the message on my screen.',
  'hello.hotkey': 'Or press {hotkey} and just talk.',
  'upgraded': "You're on {plan} now!",
  'checkout.opened': "I opened checkout in your browser. I'll switch over by myself once you've paid.",
  'checkout.error': "I couldn't open checkout. Check your connection and try again.",
  'mail.subject': '{code} is your ClippyAI code',
  'mail.line1': 'Type this code into Clippy. It expires in 15 minutes.',
  'mail.line2': "Didn't ask for this? You can ignore this email.",
} as const;

export type Key = keyof typeof en;
type Table = Record<Key, string>;

const pt: Table = {
  'setup.title': 'Vamos configurar tudo',
  'setup.sub': 'Digite seu e-mail e enviaremos um código de 6 dígitos. O Clippy é grátis, sem cartão. Já tem uma conta? Use o mesmo e-mail.',
  'email.label': 'Seu e-mail',
  'email.placeholder': 'voce@exemplo.com',
  'email.send': 'Enviar código',
  'email.sending': 'Enviando…',
  'email.suggest': 'Você quis dizer {email}?',
  'email.suggest.yes': 'Sim, corrigir',
  'code.label': 'Digite o código de 6 dígitos que enviamos para {email}',
  'code.hint': 'Pode levar um minuto. Veja também a pasta de spam.',
  'code.continue': 'Continuar',
  'code.checking': 'Verificando…',
  'code.resend': 'Enviar um novo código',
  'code.resend.wait': 'Enviar um novo código ({s}s)',
  'code.resent': 'Novo código enviado.',
  'code.change': 'Usar outro e-mail',
  'code.open.gmail': 'Abrir o Gmail',
  'code.open.outlook': 'Abrir o Outlook',
  'err.invalid_email': 'Esse e-mail não parece certo. Confira e tente de novo.',
  'err.rate_limited': 'Muitas tentativas. Aguarde {n} min e tente de novo.',
  'err.rate_limited_day': 'Muitas tentativas hoje. Tente de novo amanhã.',
  'err.wrong_code': 'Código incorreto. Tentativas restantes: {n}.',
  'err.wrong_code_last': 'Muitas tentativas erradas. Clique em "Enviar um novo código".',
  'err.code_expired': 'Esse código expirou. Clique em "Enviar um novo código".',
  'err.offline': 'Sem conexão com a internet. Verifique sua conexão e tente de novo.',
  'err.server': 'Algo deu errado do nosso lado. Tente de novo em instantes.',
  'key.link': 'Tenho uma chave de licença',
  'key.activate': 'Ativar',
  'privacy': 'O Clippy só lê sua tela para ajudar no que você pede ou para dar uma dica (as dicas podem ser desativadas em Settings → Brain). As capturas de tela nunca são armazenadas.',
  'close': 'Fechar',
  'hello': 'Oi, eu sou o Clippy! Pergunte o que quiser. Experimente uma destas:',
  'chip.screen': 'O que tem na minha tela?',
  'chip.screen.prompt': 'O que tem na minha tela agora? Faça um resumo.',
  'chip.reply': 'Me ajude a escrever uma resposta',
  'chip.reply.prompt': 'Me ajude a escrever uma resposta para a mensagem que está na minha tela.',
  'hello.hotkey': 'Ou pressione {hotkey} e fale comigo.',
  'upgraded': 'Agora você está no {plan}!',
  'checkout.opened': 'Abri o pagamento no seu navegador. Eu mudo de plano sozinho assim que o pagamento for concluído.',
  'checkout.error': 'Não consegui abrir o pagamento. Verifique sua conexão e tente de novo.',
  'mail.subject': '{code} é o seu código do ClippyAI',
  'mail.line1': 'Digite este código no Clippy. Ele expira em 15 minutos.',
  'mail.line2': 'Não pediu este código? Pode ignorar este e-mail.',
};

const es: Table = {
  'setup.title': 'Vamos a configurarlo',
  'setup.sub': 'Escribe tu correo y te enviaremos un código de 6 dígitos. Clippy es gratis, sin tarjeta. ¿Ya tienes una cuenta? Usa el mismo correo.',
  'email.label': 'Tu correo',
  'email.placeholder': 'tu@ejemplo.com',
  'email.send': 'Enviar código',
  'email.sending': 'Enviando…',
  'email.suggest': '¿Quisiste decir {email}?',
  'email.suggest.yes': 'Sí, corregir',
  'code.label': 'Escribe el código de 6 dígitos que enviamos a {email}',
  'code.hint': 'Puede tardar un minuto. Revisa también la carpeta de spam.',
  'code.continue': 'Continuar',
  'code.checking': 'Comprobando…',
  'code.resend': 'Enviar un código nuevo',
  'code.resend.wait': 'Enviar un código nuevo ({s}s)',
  'code.resent': 'Código nuevo enviado.',
  'code.change': 'Usar otro correo',
  'code.open.gmail': 'Abrir Gmail',
  'code.open.outlook': 'Abrir Outlook',
  'err.invalid_email': 'Ese correo no parece correcto. Revísalo e inténtalo de nuevo.',
  'err.rate_limited': 'Demasiados intentos. Espera {n} min e inténtalo de nuevo.',
  'err.rate_limited_day': 'Demasiados intentos por hoy. Inténtalo de nuevo mañana.',
  'err.wrong_code': 'Código incorrecto. Intentos restantes: {n}.',
  'err.wrong_code_last': 'Demasiados intentos fallidos. Haz clic en "Enviar un código nuevo".',
  'err.code_expired': 'Ese código ha caducado. Haz clic en "Enviar un código nuevo".',
  'err.offline': 'No hay conexión a internet. Revisa tu conexión e inténtalo de nuevo.',
  'err.server': 'Algo salió mal por nuestra parte. Inténtalo de nuevo en un momento.',
  'key.link': 'Tengo una clave de licencia',
  'key.activate': 'Activar',
  'privacy': 'Clippy solo lee tu pantalla para ayudarte con lo que pides o para darte un consejo (puedes desactivar los consejos en Settings → Brain). Las capturas de pantalla nunca se guardan.',
  'close': 'Cerrar',
  'hello': '¡Hola, soy Clippy! Pregúntame lo que quieras. Prueba una de estas:',
  'chip.screen': '¿Qué hay en mi pantalla?',
  'chip.screen.prompt': '¿Qué hay en mi pantalla ahora mismo? Hazme un resumen.',
  'chip.reply': 'Ayúdame a escribir una respuesta',
  'chip.reply.prompt': 'Ayúdame a escribir una respuesta al mensaje que tengo en pantalla.',
  'hello.hotkey': 'O pulsa {hotkey} y háblame.',
  'upgraded': '¡Ya estás en {plan}!',
  'checkout.opened': 'Abrí el pago en tu navegador. Cambiaré de plan yo solo en cuanto termines de pagar.',
  'checkout.error': 'No pude abrir el pago. Revisa tu conexión e inténtalo de nuevo.',
  'mail.subject': '{code} es tu código de ClippyAI',
  'mail.line1': 'Escribe este código en Clippy. Caduca en 15 minutos.',
  'mail.line2': '¿No lo pediste? Puedes ignorar este correo.',
};

const fr: Table = {
  'setup.title': 'Configurons tout ça',
  'setup.sub': 'Saisissez votre e-mail et nous vous enverrons un code à 6 chiffres. Clippy est gratuit, sans carte. Vous avez déjà un compte ? Utilisez le même e-mail.',
  'email.label': 'Votre e-mail',
  'email.placeholder': 'vous@exemple.com',
  'email.send': 'Envoyer le code',
  'email.sending': 'Envoi…',
  'email.suggest': 'Vouliez-vous dire {email} ?',
  'email.suggest.yes': 'Oui, corriger',
  'code.label': 'Saisissez le code à 6 chiffres envoyé à {email}',
  'code.hint': 'Cela peut prendre une minute. Vérifiez aussi vos courriers indésirables.',
  'code.continue': 'Continuer',
  'code.checking': 'Vérification…',
  'code.resend': 'Envoyer un nouveau code',
  'code.resend.wait': 'Envoyer un nouveau code ({s} s)',
  'code.resent': 'Nouveau code envoyé.',
  'code.change': 'Utiliser un autre e-mail',
  'code.open.gmail': 'Ouvrir Gmail',
  'code.open.outlook': 'Ouvrir Outlook',
  'err.invalid_email': 'Cet e-mail ne semble pas correct. Vérifiez-le et réessayez.',
  'err.rate_limited': 'Trop de tentatives. Patientez {n} min et réessayez.',
  'err.rate_limited_day': "Trop de tentatives aujourd'hui. Réessayez demain.",
  'err.wrong_code': 'Code incorrect. Essais restants : {n}.',
  'err.wrong_code_last': "Trop d'essais incorrects. Cliquez sur « Envoyer un nouveau code ».",
  'err.code_expired': 'Ce code a expiré. Cliquez sur « Envoyer un nouveau code ».',
  'err.offline': 'Pas de connexion à Internet. Vérifiez votre connexion et réessayez.',
  'err.server': 'Un problème est survenu de notre côté. Réessayez dans un instant.',
  'key.link': "J'ai une clé de licence",
  'key.activate': 'Activer',
  'privacy': "Clippy ne lit votre écran que pour vous aider dans ce que vous demandez ou pour vous donner un conseil (les conseils se désactivent dans Settings → Brain). Les captures d'écran ne sont jamais conservées.",
  'close': 'Fermer',
  'hello': "Bonjour, je suis Clippy ! Posez-moi n'importe quelle question. Essayez l'une de celles-ci :",
  'chip.screen': "Qu'y a-t-il sur mon écran ?",
  'chip.screen.prompt': "Qu'y a-t-il sur mon écran en ce moment ? Faites-moi un résumé.",
  'chip.reply': 'Aidez-moi à rédiger une réponse',
  'chip.reply.prompt': "Aidez-moi à rédiger une réponse au message affiché sur mon écran.",
  'hello.hotkey': 'Ou appuyez sur {hotkey} et parlez-moi.',
  'upgraded': 'Vous êtes maintenant sur {plan} !',
  'checkout.opened': "J'ai ouvert le paiement dans votre navigateur. Je changerai d'abonnement tout seul dès que le paiement sera terminé.",
  'checkout.error': "Je n'ai pas pu ouvrir le paiement. Vérifiez votre connexion et réessayez.",
  'mail.subject': '{code} est votre code ClippyAI',
  'mail.line1': 'Saisissez ce code dans Clippy. Il expire dans 15 minutes.',
  'mail.line2': 'Vous n\'avez rien demandé ? Vous pouvez ignorer cet e-mail.',
};

export const STRINGS: Record<Lang, Table> = { en, pt, es, fr };

/** First preferred language whose two-letter prefix we have a table for; English otherwise. */
export function pickLang(preferred: readonly string[]): Lang {
  for (const tag of preferred) {
    const p = (tag || '').slice(0, 2).toLowerCase();
    if (p === 'pt' || p === 'es' || p === 'fr' || p === 'en') return p;
  }
  return 'en';
}

export function isLang(v: unknown): v is Lang {
  return v === 'en' || v === 'pt' || v === 'es' || v === 'fr';
}

/** Look up a string, fill {placeholders}; a missing entry falls back to English. */
export function t(lang: Lang, key: Key, vars?: Record<string, string | number>): string {
  const raw = STRINGS[lang]?.[key] || STRINGS.en[key];
  return vars ? raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : raw;
}
