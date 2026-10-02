// @vitest-environment jsdom
// Hook spec for useReview — the flashcard session driver. Queue is a snapshot
// loaded once; grade advances after a CARD_GAP_MS beat (the graded card hidden, further
// grades ignored) and records the review in the background, never waiting on it; the
// last card waits ("saving") for every write, then ends the session. A failed write
// keeps its grade for retryFailed. Services mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { makeUserWord } from "@test/fixtures";

vi.mock("@/services/review", () => ({
  getReviewQueue: vi.fn(),
  recordReview: vi.fn(),
  REVIEW_GRADES: [1, 2, 3, 4, 5],
}));

import { useReview } from "@/hooks/useReview";
import { getReviewQueue, recordReview } from "@/services/review";
import type { ReviewQueueItem } from "@/services/review";

const mockQueue = vi.mocked(getReviewQueue);
const mockRecord = vi.mocked(recordReview);

const item = (id: string): ReviewQueueItem => makeUserWord({ userWordId: id }) as ReviewQueueItem;

beforeEach(() => {
  vi.clearAllMocks();
  mockRecord.mockResolvedValue({ userWordId: "x", confidenceRating: 3, stability: 1 } as never);
});

describe("useReview", () => {
  it("loads the queue and starts reviewing the first card", async () => {
    mockQueue.mockResolvedValue([item("a"), item("b")]);
    const { result } = renderHook(() => useReview("user-1"));

    await waitFor(() => expect(result.current.status).toBe("reviewing"));
    expect(result.current.total).toBe(2);
    expect(result.current.position).toBe(1);
    expect(result.current.current).not.toBeNull();
  });

  it("reports empty when the queue is empty", async () => {
    mockQueue.mockResolvedValue([]);
    const { result } = renderHook(() => useReview("user-1"));

    await waitFor(() => expect(result.current.status).toBe("empty"));
    expect(result.current.current).toBeNull();
  });

  it("grade records the review, advances, and bumps reviewedCount", async () => {
    mockQueue.mockResolvedValue([item("a"), item("b")]);
    const { result } = renderHook(() => useReview("user-1"));
    await waitFor(() => expect(result.current.status).toBe("reviewing"));
    const firstId = result.current.current!.userWordId;

    await act(async () => {
      await result.current.grade(4);
    });

    // `current` carries the card's pre-review state so a grade taken OFFLINE can echo
    // it straight back — the queued path can't compute a new stability (srs_leveling is
    // server-only), so it reports the old values rather than inventing a schedule.
    expect(mockRecord).toHaveBeenCalledWith({
      userWordId: firstId,
      grade: 4,
      // Word-first unless the view says the card was flipped (see the test below).
      reversed: false,
      current: { stability: null, confidenceRating: 0, lastReviewedDate: null },
    });
    await waitFor(() => expect(result.current.position).toBe(2));
    expect(result.current.reviewedCount).toBe(1);
    expect(result.current.status).toBe("reviewing");
  });

  it("counts a QUEUED grade as pending but still advances the session", async () => {
    // With no network the grade is stored on the device and resolves as `queued`, so
    // the card is done from the user's point of view — the session must not stall.
    mockQueue.mockResolvedValue([item("a"), item("b")]);
    mockRecord.mockResolvedValue({
      userWordId: "a", stability: 0, confidenceRating: 0, lastReviewedDate: "", queued: true,
    });
    const { result } = renderHook(() => useReview("user-1"));
    await waitFor(() => expect(result.current.status).toBe("reviewing"));

    await act(async () => {
      await result.current.grade(3);
    });

    expect(result.current.pendingCount).toBe(1);
    expect(result.current.reviewedCount).toBe(1);
    await waitFor(() => expect(result.current.position).toBe(2));
    expect(result.current.error).toBeNull();
  });

  it("grading the last card finishes the session", async () => {
    mockQueue.mockResolvedValue([item("only")]);
    const { result } = renderHook(() => useReview("user-1"));
    await waitFor(() => expect(result.current.status).toBe("reviewing"));

    await act(async () => {
      await result.current.grade(3);
    });

    expect(result.current.status).toBe("done");
    expect(result.current.reviewedCount).toBe(1);
  });

  it("sets status=error when the queue fails to load", async () => {
    mockQueue.mockRejectedValue(new Error("nope"));
    const { result } = renderHook(() => useReview("user-1"));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBeTruthy();
  });

  it("pauses CARD_GAP_MS between cards, ignoring grades in the gap, then advances BEFORE the write lands", async () => {
    mockQueue.mockResolvedValue([item("a"), item("b")]);
    let land!: (v: unknown) => void;
    mockRecord.mockImplementationOnce(() => new Promise((r) => (land = r)) as never);
    const { result } = renderHook(() => useReview("user-1"));
    await waitFor(() => expect(result.current.status).toBe("reviewing"));

    act(() => {
      result.current.grade(4);
    });
    // The gap: the graded card is held (hidden by the view), and a second tap is ignored.
    expect(result.current.advancing).toBe(true);
    expect(result.current.position).toBe(1);
    act(() => {
      result.current.grade(1);
    });
    expect(mockRecord).toHaveBeenCalledTimes(1);

    // The write is still in flight, and after the gap the next card is showing.
    await waitFor(() => expect(result.current.position).toBe(2));
    expect(result.current.advancing).toBe(false);
    expect(result.current.status).toBe("reviewing");

    await act(async () => {
      land({ userWordId: "a", confidenceRating: 4, stability: 5 });
    });
  });

  it("waits in 'saving' after the last grade until every write has landed", async () => {
    mockQueue.mockResolvedValue([item("a")]);
    let land!: (v: unknown) => void;
    mockRecord.mockImplementationOnce(() => new Promise((r) => (land = r)) as never);
    const { result } = renderHook(() => useReview("user-1"));
    await waitFor(() => expect(result.current.status).toBe("reviewing"));

    act(() => {
      result.current.grade(5);
    });
    expect(result.current.status).toBe("saving");
    expect(result.current.submitting).toBe(true);

    await act(async () => {
      land({ userWordId: "a", confidenceRating: 5, stability: 9 });
    });
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.gradedConfidence.get("a")).toBe(5);
  });

  it("keeps a failed grade and re-sends it with retryFailed — no re-grading", async () => {
    const a = item("a");
    mockQueue.mockResolvedValue([a]);
    mockRecord.mockRejectedValueOnce(new Error("record failed"));
    const { result } = renderHook(() => useReview("user-1"));
    await waitFor(() => expect(result.current.status).toBe("reviewing"));

    await act(async () => {
      result.current.grade(2);
    });
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.failed).toEqual([{ card: a, grade: 2, reversed: false }]);
    expect(result.current.error).toBeTruthy();

    await act(async () => {
      result.current.retryFailed();
    });
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(result.current.failed).toEqual([]);
    expect(mockRecord).toHaveBeenCalledTimes(2);
    expect(mockRecord.mock.calls[1][0]).toMatchObject({ userWordId: "a", grade: 2 });
  });

  // The direction is a fact about the moment of grading, so a retry must re-send the
  // one it was graded in — not whatever the quiz is flipped to by then.
  it("a grade given on a flipped card carries reversed, through a retry too", async () => {
    const a = item("a");
    mockQueue.mockResolvedValue([a]);
    mockRecord.mockRejectedValueOnce(new Error("record failed"));
    const { result } = renderHook(() => useReview("user-1"));
    await waitFor(() => expect(result.current.status).toBe("reviewing"));

    await act(async () => {
      result.current.grade(4, true);
    });
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(mockRecord.mock.calls[0][0]).toMatchObject({ userWordId: "a", grade: 4, reversed: true });

    await act(async () => {
      result.current.retryFailed();
    });
    await waitFor(() => expect(result.current.status).toBe("done"));
    expect(mockRecord.mock.calls[1][0]).toMatchObject({ userWordId: "a", grade: 4, reversed: true });
  });

  it("restart reloads the queue", async () => {
    mockQueue.mockResolvedValue([item("a")]);
    const { result } = renderHook(() => useReview("user-1"));
    await waitFor(() => expect(result.current.status).toBe("reviewing"));

    await act(async () => {
      result.current.restart();
    });

    await waitFor(() => expect(result.current.status).toBe("reviewing"));
    expect(mockQueue).toHaveBeenCalledTimes(2);
  });

  it("newQuiz re-ranks from scratch (no subset restriction)", async () => {
    mockQueue.mockResolvedValue([item("a"), item("b")]);
    const { result } = renderHook(() => useReview("user-1"));
    await waitFor(() => expect(result.current.status).toBe("reviewing"));

    await act(async () => {
      result.current.newQuiz();
    });

    await waitFor(() => expect(mockQueue).toHaveBeenCalledTimes(2));
    // The fresh session queries with no explicit id subset.
    expect(mockQueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ userWordIds: undefined })
    );
  });

  it("retry re-runs the EXACT words from the finished session", async () => {
    mockQueue.mockResolvedValue([item("a"), item("b")]);
    const { result } = renderHook(() => useReview("user-1"));
    await waitFor(() => expect(result.current.status).toBe("reviewing"));

    // Finish the session so `done` holds the reviewed set.
    await act(async () => {
      await result.current.grade(3);
    });
    await waitFor(() => expect(result.current.position).toBe(2));
    await act(async () => {
      await result.current.grade(3);
    });
    expect(result.current.status).toBe("done");

    await act(async () => {
      result.current.retry();
    });

    await waitFor(() => expect(mockQueue).toHaveBeenCalledTimes(2));
    // Retry passes exactly the just-reviewed ids as the subset.
    const calls = mockQueue.mock.calls;
    const lastCall = calls[calls.length - 1][0];
    expect([...(lastCall.userWordIds ?? [])].sort()).toEqual(["a", "b"]);
  });
});
