// public/js/chat/speech-cleaner.js
// Limpieza y normalización de dictado de voz para agy-rc.
// Corrige términos técnicos en inglés dictados en español, nombres de modelos (Gemini, Claude...),
// comandos de puntuación ("punto y aparte", "coma"...) y desduplica stutters del SpeechRecognition.

/**
 * Corrige errores fonéticos habituales al dictar términos técnicos en español.
 * @param {string} text
 * @returns {string}
 */
function fixSpanishTechTerms(text) {
  let s = text;

  // Frases de la app
  s = s.replace(/\bno\s+sesi[oó]n\b/gi, 'nueva sesión');
  s = s.replace(/\ben\s+esta\s+app\s+whatsapp\b/gi, 'en esta app');
  s = s.replace(/\ben\s+la\s+app\s+whatsapp\b/gi, 'en la app');
  s = s.replace(/\b(nueva\s+sesi[oó]n)\s+whatsapp\b/gi, '$1 en la app');
  s = s.replace(/\bwhatsapp\b/gi, 'en la app'); // alucinación habitual por "en la app" / "esta app"
  s = s.replace(/\bme\s+hacen\s+de\s+modelo\b/gi, 'selección de modelo');

  // Antigravity & agy
  s = s.replace(/\b(antigravedad|anti\s+gravity|anti-gravity)\b/gi, 'Antigravity');
  s = s.replace(/\bagy\s+rc\b/gi, 'agy-rc');
  s = s.replace(/\b(agi|ayi|hagi)\b(?=\s+(?:rc|cli|models|run|chat|commands|\/))/gi, 'agy');

  // Modelos: Gemini, Claude, GPT
  s = s.replace(/\b(jimmy|yemeni|yemini|ll[eé]mini|chemini|g[eé]minis|geminis)\b/gi, 'Gemini');
  s = s.replace(/\b(ya\s+10\.8|ya\s+3\.8)\b/gi, 'Gemini 3.8');
  s = s.replace(/\bGemini\s+(?:tres\s+punto\s+ocho|3\s+8|38)\b/gi, 'Gemini 3.8');
  s = s.replace(/\b(?:tres\s+punto\s+ocho)\b/gi, '3.8');
  s = s.replace(/\b(?:tres\s+punto\s+siete)\b/gi, '3.7');
  s = s.replace(/\b(?:tres\s+punto\s+uno)\b/gi, '3.1');

  s = s.replace(/\b(clod|claud)\b(?=\s+(?:sonnet|opus|haiku|3|4))/gi, 'Claude');
  s = s.replace(/\bsonet\b/gi, 'Sonnet');
  s = s.replace(/\b(gepeto|gepete)\b/gi, 'GPT');

  // Esfuerzos / Variantes (High, Medium, Low)
  s = s.replace(/\b(3\.[1678]|pro|flash|gemini|esfuerzo)\s+(?:jai|hay|hi|jaigh)\b/gi, '$1 High');
  s = s.replace(/\b(3\.[1678]|pro|flash|gemini|esfuerzo)\s+(?:lo|lou)\b/gi, '$1 Low');
  s = s.replace(/\b(3\.[1678]|pro|flash|gemini|esfuerzo)\s+(?:m[eé]dium|medio)\b/gi, '$1 Medium');
  s = s.replace(/\b(3\.[1678])\s+h\b/gi, '$1 High');
  s = s.replace(/\b(3\.[1678])\s+l\b/gi, '$1 Low');
  s = s.replace(/\b(3\.[1678])\s+m\b/gi, '$1 Medium');
  s = s.replace(/\besfuerzo\s+(?:lo|lou|l)\b/gi, 'esfuerzo Low');
  s = s.replace(/\besfuerzo\s+(?:jai|hay|hi|jaigh|h)\b/gi, 'esfuerzo High');
  s = s.replace(/\besfuerzo\s+(?:m[eé]dium|medio|m)\b/gi, 'esfuerzo Medium');

  // Herramientas y tecnologías comunes
  s = s.replace(/\b(gijap|gijob|guithub|git\s+hub)\b/gi, 'GitHub');
  s = s.replace(/\bgu[ií]t\b/gi, 'git');
  s = s.replace(/\b(comit|comitea|comitear|comit[eé])\b/gi, 'commit');
  s = s.replace(/\b(pul\s+request|por\s+el\s+resto)\b/gi, 'pull request');
  s = s.replace(/\b(branc|branche)\b/gi, 'branch');
  s = s.replace(/\b(merch|mergea|mergear)\b/gi, 'merge');
  s = s.replace(/\b(puch|pushea|pushear)\b/gi, 'push');
  s = s.replace(/\b(doquer|d[oó]quer|do\s+que)\b/gi, 'docker');
  s = s.replace(/\b(docker\s+fai|doker\s+file|doquer\s+fail|dockerfile)\b/gi, 'Dockerfile');
  s = s.replace(/\b(temux|t-mux|ti\s+mux)\b/gi, 'tmux');
  s = s.replace(/\b(baqu[eé]n|vaquen|back\s+end)\b/gi, 'backend');
  s = s.replace(/\b(fron\s+end|front\s+end)\b/gi, 'frontend');
  s = s.replace(/\b(en\s*poin|enpoint)\b/gi, 'endpoint');
  s = s.replace(/\b(deploi|deployar)\b/gi, 'deploy');
  s = s.replace(/\b(ene\s+pe\s+eme)\b/gi, 'npm');
  s = s.replace(/\b(node\s*yeis|node\s*lleis|nod\s+yeis)\b/gi, 'Node.js');
  s = s.replace(/\b(taipscrip|type\s*script)\b/gi, 'TypeScript');
  s = s.replace(/\b(llavascrip|yavascrip|java\s*script)\b/gi, 'JavaScript');
  s = s.replace(/\b(paiton|paito)\b/gi, 'Python');
  s = s.replace(/\bweb\s*socket(s?)\b/gi, 'WebSocket$1');
  s = s.replace(/\blocal\s*host\b/gi, 'localhost');
  s = s.replace(/\b(jeison|jey\s*son)\b/gi, 'JSON');
  s = s.replace(/\b(apei|a\s+pi)\b/gi, 'API');
  s = s.replace(/\bce\s+ese\s+ese\b/gi, 'CSS');
  s = s.replace(/\bhache\s+te\s+eme\s+ele\b/gi, 'HTML');
  s = s.replace(/\bese\s+ese\s+hache\b/gi, 'SSH');
  s = s.replace(/\bu\s+erre\s+ele\b/gi, 'URL');
  s = s.replace(/\b(mar\s*daun|marcdown)\b/gi, 'Markdown');
  s = s.replace(/\b(escript|scrip)\b/gi, 'script');
  s = s.replace(/\b(?:el|un|este|ese)\s+(?:bag|vago)\b/gi, (m) => m.replace(/(?:bag|vago)/i, 'bug'));

  return s;
}

/**
 * Aplica comandos de puntuación dictados por voz.
 * @param {string} text
 * @param {string} lang
 * @returns {string}
 */
function fixPunctuationCommands(text, lang) {
  let s = text;
  if (lang.startsWith('es')) {
    s = s.replace(/\s*\bpunto\s+y\s+aparte\b\s*/gi, '\n\n');
    s = s.replace(/\s*\bpunto\s+y\s+seguido\b\s*/gi, '. ');
    s = s.replace(/\s*\b(nueva\s+l[ií]nea|salto\s+de\s+l[ií]nea)\b\s*/gi, '\n');
    s = s.replace(/\s*\bdos\s+puntos\b\s*/gi, ': ');
    s = s.replace(/(\w+)\s+\bcoma\b\s*/gi, '$1, ');
    s = s.replace(/\s*\b(signo\s+de\s+interrogaci[oó]n|cerrar\s+interrogaci[oó]n)\b/gi, '?');
    s = s.replace(/\b(abrir\s+interrogaci[oó]n)\b\s*/gi, '¿');
    s = s.replace(/\s*\b(signo\s+de\s+exclamaci[oó]n|cerrar\s+exclamaci[oó]n)\b/gi, '!');
    s = s.replace(/\b(abrir\s+exclamaci[oó]n)\b\s*/gi, '¡');
  } else {
    s = s.replace(/\s*\bnew\s+line\b\s*/gi, '\n');
    s = s.replace(/\s*\bperiod\b\s*/gi, '. ');
    s = s.replace(/(\w+)\s+\bcomma\b\s*/gi, '$1, ');
    s = s.replace(/\s*\bquestion\s+mark\b\s*/gi, '?');
    s = s.replace(/\s*\bexclamation\s+(point|mark)\b\s*/gi, '!');
    s = s.replace(/\s*\bcolon\b\s*/gi, ': ');
  }
  return s;
}

/**
 * Limpia duplicados accidentales generados cuando el motor reinicia sesión.
 * @param {string} text
 * @returns {string}
 */
function dedupeStutters(text) {
  // Frases de 1 a 3 palabras repetidas consecutivamente: "en esta app en esta app" -> "en esta app"
  return text.replace(/\b([a-záéíóúñA-ZÁÉÍÓÚÑ0-9_-]+(?:\s+[a-záéíóúñA-ZÁÉÍÓÚÑ0-9_-]+){0,2})\s+\1\b/gi, '$1');
}

/**
 * Normaliza espacios y puntuación.
 * @param {string} text
 * @returns {string}
 */
function cleanFormatting(text) {
  let s = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([,.:;?!])/g, '$1')
    .replace(/([,:;?!])(?=[a-záéíóúñA-ZÁÉÍÓÚÑ0-9])/g, '$1 ')
    .replace(/(?<!\d)\.(?=[a-záéíóúñA-ZÁÉÍÓÚÑ])/g, '. ')
    .replace(/\n +/g, '\n')
    .replace(/ +\n/g, '\n')
    .trim();

  // Capitaliza la primera letra del texto y tras punto / salto de línea
  s = s.replace(/(^|[.?!]\s+|\n+)([a-záéíóúñ])/g, (_, p1, p2) => p1 + p2.toUpperCase());
  return s;
}

/**
 * Procesa el texto reconocido por SpeechRecognition según el idioma configurado.
 * @param {string} spoken
 * @param {string} [lang='es-ES']
 * @returns {string}
 */
export function cleanSpeechText(spoken, lang = 'es-ES') {
  if (!spoken) return '';
  let s = String(spoken);
  s = dedupeStutters(s);
  s = fixPunctuationCommands(s, lang);
  if (lang.startsWith('es')) {
    s = fixSpanishTechTerms(s);
  } else {
    // Normalización de modelos en inglés
    s = s.replace(/\b(gemini|claude|antigravity)\b/gi, (m) => m.charAt(0).toUpperCase() + m.slice(1).toLowerCase());
    s = s.replace(/\bagy\b/gi, 'agy');
    s = s.replace(/\bgithub\b/gi, 'GitHub');
    s = s.replace(/\bdocker\b/gi, 'docker');
    s = s.replace(/\btmux\b/gi, 'tmux');
  }
  s = cleanFormatting(s);
  return s;
}
