// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { FollowUpQuestion } from "../../types";

/** Jawaban internal selalu di-key dengan id pertanyaan. */
export type FollowUpAnswers = Record<string, string>;

export type CustomAnswerState = Record<string, boolean>;

export interface FollowUpState {
  questions: FollowUpQuestion[];
  answers: FollowUpAnswers;
  customAnswerActive: CustomAnswerState;
}

/**
 * Gabungkan ronde secara stabil. ID adalah identitas pertanyaan; bila server
 * mengirim ulang ID yang sama, versi terbaru menggantikan versi lama tanpa
 * mengubah posisi pertanyaan tersebut.
 */
export function mergeFollowUpQuestions(
  current: readonly FollowUpQuestion[],
  next: readonly FollowUpQuestion[],
): FollowUpQuestion[] {
  const merged = new Map<string, FollowUpQuestion>();

  for (const question of current) merged.set(question.id, question);
  for (const question of next) merged.set(question.id, question);

  return [...merged.values()];
}

/** Pilihan yang ditampilkan kartu; saran menjadi pilihan tunggal bila perlu. */
export function getFollowUpOptions(question: FollowUpQuestion): string[] {
  return question.options?.length ? [...question.options] : [question.suggestedAnswer];
}

/** Nilai awal yang dipakai untuk pertanyaan baru. */
export function getPrefilledFollowUpAnswer(question: FollowUpQuestion): string {
  return question.options?.[0] ?? question.suggestedAnswer;
}

/**
 * Baca jawaban ke state internal. `q.id` didahulukan, tetapi sesi lama yang
 * masih menyimpan key teks pertanyaan tetap terbaca saat dimuat.
 */
export function readStoredFollowUpAnswers(
  questions: readonly FollowUpQuestion[],
  stored: Readonly<Record<string, string>> | null | undefined,
): FollowUpAnswers {
  const answers: FollowUpAnswers = {};

  for (const question of questions) {
    const answer = stored?.[question.id] ?? stored?.[question.question];
    if (answer !== undefined) answers[question.id] = answer;
  }

  return answers;
}

/** Baca jawaban tersimpan dan pra-isi pertanyaan yang belum dijawab. */
export function prefillFollowUpAnswers(
  questions: readonly FollowUpQuestion[],
  stored: Readonly<Record<string, string>> | null | undefined,
): FollowUpAnswers {
  const storedAnswers = readStoredFollowUpAnswers(questions, stored);
  const answers: FollowUpAnswers = {};

  for (const question of questions) {
    answers[question.id] = storedAnswers[question.id] ?? getPrefilledFollowUpAnswer(question);
  }

  return answers;
}

/** Buat state awal yang bisa dipakai PlanIntake maupun kartu transcript. */
export function createFollowUpState(
  questions: readonly FollowUpQuestion[],
  stored: Readonly<Record<string, string>> | null | undefined = undefined,
): FollowUpState {
  return {
    questions: [...questions],
    answers: prefillFollowUpAnswers(questions, stored),
    customAnswerActive: {},
  };
}

/** Gabungkan satu ronde baru dan pra-isi hanya lewat satu implementasi. */
export function mergeFollowUpRound(
  state: FollowUpState,
  next: readonly FollowUpQuestion[],
): FollowUpState {
  const questions = mergeFollowUpQuestions(state.questions, next);
  const customAnswerActive: CustomAnswerState = {};

  for (const question of questions) {
    if (state.customAnswerActive[question.id]) customAnswerActive[question.id] = true;
  }

  return {
    questions,
    answers: prefillFollowUpAnswers(questions, state.answers),
    customAnswerActive,
  };
}

/**
 * Konversi state internal ke payload lama. Server menulis jawaban langsung ke
 * prompt dengan key teks pertanyaan, jadi ID tidak boleh melewati batas HTTP.
 */
export function answersToQuestionTextKeys(
  questions: readonly FollowUpQuestion[],
  answers: Readonly<Record<string, string>>,
): FollowUpAnswers {
  const transportAnswers: FollowUpAnswers = {};

  for (const question of questions) {
    const answer = answers[question.id] ?? answers[question.question];
    if (answer !== undefined) transportAnswers[question.question] = answer;
  }

  return transportAnswers;
}

// Nama singkat ini dipakai langsung oleh boundary transport agent.
export const toTransportAnswers = answersToQuestionTextKeys;

/**
 * Konversi payload/sesi lama kembali ke state internal. Fallback ID juga
 * membuat fungsi ini aman dipakai bila sumbernya sudah memakai format baru.
 */
export function answersFromQuestionTextKeys(
  questions: readonly FollowUpQuestion[],
  stored: Readonly<Record<string, string>> | null | undefined,
): FollowUpAnswers {
  return readStoredFollowUpAnswers(questions, stored);
}
