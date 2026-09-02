import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSpeechText } from '../public/js/chat/speech-cleaner.js';

describe('cleanSpeechText', () => {
  test('corrige caso real del usuario (Gemini 3.8 High, nueva sesión, etc.)', () => {
    const raw = 'en esta app al elegir no sesión WhatsApp me hacen de modelo y el modelo me parece Jimmy 3.8 High luego ya 10.8 medio 3.8 L pero luego hay otra sección que pone esfuerzo entonces si yo elijo ya 3.8 H y después de esfuerzo lo cual se aplica de los dos';
    const cleaned = cleanSpeechText(raw, 'es-ES');
    assert.ok(cleaned.includes('nueva sesión'), 'debe corregir "no sesión" a "nueva sesión"');
    assert.ok(cleaned.includes('Gemini 3.8 High'), 'debe corregir "Jimmy 3.8 High"');
    assert.ok(cleaned.includes('Gemini 3.8 Medium') || cleaned.includes('Gemini 3.8 medio'), 'debe corregir "ya 10.8 medio"');
    assert.ok(cleaned.includes('3.8 Low'), 'debe corregir "3.8 L" a "3.8 Low"');
    assert.ok(cleaned.includes('esfuerzo Low'), 'debe corregir "esfuerzo lo"');
  });

  test('corrige modelos y tecnologías habituales en español', () => {
    assert.equal(cleanSpeechText('haz un comit en guít y abre un pul request', 'es-ES'), 'Haz un commit en git y abre un pull request');
    assert.equal(cleanSpeechText('arranca el contenedor de doquer con temux', 'es-ES'), 'Arranca el contenedor de docker con tmux');
    assert.equal(cleanSpeechText('sube el código a gijap', 'es-ES'), 'Sube el código a GitHub');
    assert.equal(cleanSpeechText('crea un enpoint en el baquén con taipscrip', 'es-ES'), 'Crea un endpoint en el backend con TypeScript');
    assert.equal(cleanSpeechText('vamos a usar antigravedad con agy cli', 'es-ES'), 'Vamos a usar Antigravity con agy cli');
  });

  test('comandos de puntuación por voz en español', () => {
    assert.equal(cleanSpeechText('hola punto y seguido cómo estás signo de interrogación', 'es-ES'), 'Hola. Cómo estás?');
    assert.equal(cleanSpeechText('primer paso dos puntos instalar npm punto y aparte segundo paso', 'es-ES'), 'Primer paso: instalar npm\n\nSegundo paso');
  });

  test('desduplica stutters causados por reinicio de sesión', () => {
    assert.equal(cleanSpeechText('en esta app en esta app vamos a ver', 'es-ES'), 'En esta app vamos a ver');
  });

  test('soporta inglés (en-US) con puntuación', () => {
    assert.equal(cleanSpeechText('fix the bug in backend new line run tests period', 'en-US'), 'Fix the bug in backend\nRun tests.');
  });
});
