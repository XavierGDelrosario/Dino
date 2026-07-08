// @vitest-environment jsdom
// Hook spec for useReview — the flashcard session driver. Queue is a snapshot
// loaded once; grade records a review and advances; the last card ends the
// session. A failed grade KEEPS the card so the user can retry. Services mocked.
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

    expect(mockRecord).toHaveBeenCalledWith({ userWordId: firstId, grade: 4 });
    expect(result.current.position).toBe(2);
    expect(result.current.reviewedCount).toBe(1);
    expect(result.current.status).toBe("reviewing");
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

  it("keeps the card and surfaces the error when a grade fails", async () => {
    mockQueue.mockResolvedValue([item("a"), item("b")]);
    mockRecord.mockRejectedValueOnce(new Error("record failed"));
    const { result } = renderHook(() => useReview("user-1"));
    await waitFor(() => expect(result.current.status).toBe("reviewing"));
    const firstId = result.current.current!.userWordId;

    await act(async () => {
      await result.current.grade(2);
    });

    // Did not advance; error surfaced; count unchanged.
    expect(result.current.current!.userWordId).toBe(firstId);
    expect(result.current.position).toBe(1);
    expect(result.current.reviewedCount).toBe(0);
    expect(result.current.error).toBeTruthy();
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
