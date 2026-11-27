import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const EN_STRINGS = {
  appName: 'PulseChat',
  signOut: 'Sign out',
  security: 'Security',
  admin: 'Admin',
  catchMeUp: 'Catch me up',
  summarizing: 'Summarizing…',
  invite: 'Invite',
  leave: 'Leave',
  delete: 'Delete',
  notifyAll: 'Notify: All',
  notifyMentions: 'Notify: @Mentions',
  notifyMuted: 'Notify: Muted',
  language: 'Language',
  online: 'Online',
  offline: 'Offline',
  membersCount: '{{count}} members',
  disappearingBanner: 'Disappearing messages are enabled: new messages expire after {{duration}}.',
};

const HI_STRINGS = {
  appName: 'पल्सचैट',
  signOut: 'साइन आउट',
  security: 'सुरक्षा',
  admin: 'प्रशासक',
  catchMeUp: 'सारांश दिखाएं',
  summarizing: 'सारांश बन रहा है…',
  invite: 'आमंत्रित करें',
  leave: 'छोड़ें',
  delete: 'हटाएं',
  notifyAll: 'सूचना: सभी',
  notifyMentions: 'सूचना: @उल्लेख',
  notifyMuted: 'सूचना: म्यूट',
  language: 'भाषा',
  online: 'ऑनलाइन',
  offline: 'ऑफ़लाइन',
  membersCount: '{{count}} सदस्य',
  disappearingBanner: 'गायब होने वाले संदेश चालू हैं: नए संदेश {{duration}} के बाद समाप्त हो जाएंगे।',
};

function toPseudo(str) {
  return `[!! ${str.replace(/[aeiou]/gi, (ch) => `${ch}${ch}`)} !!]`;
}

const PSEUDO_STRINGS = Object.fromEntries(
  Object.entries(EN_STRINGS).map(([k, v]) => [k, toPseudo(v)])
);

const STORAGE_KEY = 'pulsechat_lang';
const savedLang =
  typeof window !== 'undefined' ? window.localStorage?.getItem(STORAGE_KEY) : null;

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: EN_STRINGS },
    hi: { translation: HI_STRINGS },
    pseudo: { translation: PSEUDO_STRINGS },
  },
  lng: savedLang || 'en',
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

export function changeLanguage(lang) {
  const next = ['en', 'hi', 'pseudo'].includes(lang) ? lang : 'en';
  if (typeof window !== 'undefined') {
    window.localStorage?.setItem(STORAGE_KEY, next);
  }
  return i18n.changeLanguage(next);
}

export function formatLocalizedTime(dateInput, lang = i18n.language) {
  const locale = lang === 'hi' ? 'hi-IN' : 'en-US';
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(dateInput));
}

export function formatLocalizedNumber(num, lang = i18n.language) {
  const locale = lang === 'hi' ? 'hi-IN' : 'en-US';
  return new Intl.NumberFormat(locale).format(num);
}

export default i18n;
