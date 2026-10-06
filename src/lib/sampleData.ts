// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { ProjectInput } from "../types";
import { Language } from "./i18n";

interface SampleCopy {
  name: string;
  tagline: string;
  input: ProjectInput;
}

export interface SampleProject {
  id: string;
  badge: string;
  // Isi template bukan sekadar label: deskripsinya mengisi form dan diteruskan
  // ke LLM, jadi ia harus ada dalam bahasa yang sedang dipakai.
  copy: Record<Language, SampleCopy>;
}

export const sampleText = (sample: SampleProject, lang: Language): SampleCopy => sample.copy[lang];

export const SAMPLE_PROJECTS: SampleProject[] = [
  {
    id: "ai-code-reviewer",
    badge: "AI Developer Tool",
    copy: {
      en: {
        name: "AI Automated Code Reviewer",
        tagline: "A GitHub / GitLab bot that analyses PRs, spots bugs, and suggests refactors.",
        input: {
          title: "AI Automated Code Reviewer Bot",
          description:
            "An automated code review bot integrated with a Git repository. The bot analyses every newly opened pull request, detects potential bugs, security vulnerabilities and coding-standard violations, and leaves suggested fixes inline on the relevant lines.",
          targetAudience: "Development teams, tech leads, DevOps and QA engineers",
          techStackPreference: "Node.js, Express, React, GitHub Webhook API, Gemini API",
          answersToFollowUp: {},
        },
      },
      id: {
        name: "AI Automated Code Reviewer",
        tagline: "Bot GitHub / GitLab untuk analisa PR, deteksi bug, dan rekomendasi refactoring otomatis.",
        input: {
          title: "AI Automated Code Reviewer Bot",
          description:
            "Aplikasi bot otomatisasi peninjau kode (code review) yang terintegrasi dengan repository Git. Bot akan menganalisis Pull Request (PR) yang baru dibuka, mendeteksi potensi bug, security vulnerability, ketidaksesuaian coding standard, serta memberikan saran perbaikan langsung pada baris kode terkait.",
          targetAudience: "Developer team, Tech Leads, DevOps & QA Engineer",
          techStackPreference: "Node.js, Express, React, GitHub Webhook API, Gemini API",
          answersToFollowUp: {},
        },
      },
    },
  },
  {
    id: "saas-lms-ai",
    badge: "EdTech SaaS",
    copy: {
      en: {
        name: "Online Course SaaS with an AI Tutor",
        tagline: "An LMS with automatic quiz generation and a personal AI tutor available around the clock.",
        input: {
          title: "Smart LMS with a Personal AI Tutor",
          description:
            "An integrated online course platform where instructors upload module material and students learn interactively. It includes an AI tutor that answers student questions from the module material, generates quiz summaries automatically, and tracks each learner's progress.",
          targetAudience: "School and university students, course instructors, and training providers",
          techStackPreference: "React, Tailwind, Express, PostgreSQL, Gemini API",
          answersToFollowUp: {},
        },
      },
      id: {
        name: "SaaS Platform Kursus Online + Tutor AI",
        tagline: "Platform LMS dengan generator kuis otomatis dan AI Tutor personal 24/7.",
        input: {
          title: "Smart LMS dengan AI Tutor Personal",
          description:
            "Platform kursus online terpadu yang memfasilitasi pengajar untuk mengunggah materi modul dan memungkinkan siswa belajar secara interaktif. Dilengkapi AI Tutor yang bisa menjawab pertanyaan siswa berdasarkan materi modul, membuat rangkuman kuis otomatis, serta melacak progres belajar pengguna.",
          targetAudience: "Siswa, Mahasiswa, Instruktur Kursus, & Lembaga Pelatihan",
          techStackPreference: "React, Tailwind, Express, PostgreSQL, Gemini API",
          answersToFollowUp: {},
        },
      },
    },
  },
  {
    id: "inventory-smart-pos",
    badge: "Fintech & Retail",
    copy: {
      en: {
        name: "Smart POS & Inventory Forecast",
        tagline: "A small-business till with automatic stock prediction and AI financial reporting.",
        input: {
          title: "Smart POS & Inventory Forecast for Small Retail",
          description:
            "A point-of-sale system for retail shops and small businesses with barcode scanning and transaction recording, plus an AI analysis module that predicts which stock is about to run out and recommends promotions based on weekly sales trends.",
          targetAudience: "Owners of retail shops, minimarkets and cafes, and their till staff",
          techStackPreference: "React, Express, SQLite/PostgreSQL, Gemini API",
          answersToFollowUp: {},
        },
      },
      id: {
        name: "Smart POS & Inventory Forecast",
        tagline: "Kasir digital UMKM dengan prediksi stok otomatis dan laporan keuangan AI.",
        input: {
          title: "Smart POS & Inventory Forecast UMKM",
          description:
            "Sistem Kasir Point-of-Sale (POS) untuk toko ritel dan UMKM dengan fitur pemindaian barcode, pencatatan transaksi kasir, serta modul analisis AI untuk memprediksi stok barang yang hampir habis dan memberikan rekomendasi promosi berdasarkan tren penjualan mingguan.",
          targetAudience: "Pemilik Toko Ritel, Minimarket, Cafe, dan Staff Kasir UMKM",
          techStackPreference: "React, Express, SQLite/PostgreSQL, Gemini API",
          answersToFollowUp: {},
        },
      },
    },
  },
];
