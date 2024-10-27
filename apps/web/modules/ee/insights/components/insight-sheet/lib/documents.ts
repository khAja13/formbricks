import { documentCache } from "@/lib/cache/document";
import { insightCache } from "@/lib/cache/insight";
import { Prisma } from "@prisma/client";
import { cache as reactCache } from "react";
import { z } from "zod";
import { prisma } from "@formbricks/database";
import { cache } from "@formbricks/lib/cache";
import { DOCUMENTS_PER_PAGE } from "@formbricks/lib/constants";
import { validateInputs } from "@formbricks/lib/utils/validate";
import { ZId } from "@formbricks/types/common";
import {
  TDocument,
  TDocumentFilterCriteria,
  ZDocument,
  ZDocumentFilterCriteria,
} from "@formbricks/types/documents";
import { DatabaseError } from "@formbricks/types/errors";
import { TSurveyQuestionId, ZSurveyQuestionId } from "@formbricks/types/surveys/types";

export const getDocumentsByInsightId = reactCache(
  (
    insightId: string,
    limit?: number,
    offset?: number,
    filterCriteria?: TDocumentFilterCriteria
  ): Promise<TDocument[]> =>
    cache(
      async () => {
        validateInputs(
          [insightId, ZId],
          [limit, z.number().optional()],
          [offset, z.number().optional()],
          [filterCriteria, ZDocumentFilterCriteria.optional()]
        );

        limit = limit ?? DOCUMENTS_PER_PAGE;
        try {
          const documents = await prisma.document.findMany({
            where: {
              documentInsights: {
                some: {
                  insightId,
                },
              },
              createdAt: {
                gte: filterCriteria?.createdAt?.min,
                lte: filterCriteria?.createdAt?.max,
              },
            },
            orderBy: [
              {
                createdAt: "desc",
              },
            ],
            take: limit ? limit : undefined,
            skip: offset ? offset : undefined,
          });

          return documents;
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError) {
            throw new DatabaseError(error.message);
          }

          throw error;
        }
      },
      [`getDocumentsByInsightId-${insightId}-${limit}-${offset}`],
      {
        tags: [documentCache.tag.byInsightId(insightId), insightCache.tag.byId(insightId)],
      }
    )()
);

export const getDocumentsByInsightIdSurveyIdQuestionId = reactCache(
  (
    insightId: string,
    surveyId: string,
    questionId: TSurveyQuestionId,
    limit?: number,
    offset?: number
  ): Promise<TDocument[]> =>
    cache(
      async () => {
        validateInputs(
          [insightId, ZId],
          [surveyId, ZId],
          [questionId, ZSurveyQuestionId],
          [limit, z.number().optional()],
          [offset, z.number().optional()]
        );

        limit = limit ?? DOCUMENTS_PER_PAGE;
        try {
          const documents = await prisma.document.findMany({
            where: {
              questionId,
              surveyId,
              documentInsights: {
                some: {
                  insightId,
                },
              },
            },
            orderBy: [
              {
                createdAt: "desc",
              },
            ],
            take: limit ? limit : undefined,
            skip: offset ? offset : undefined,
          });

          return documents;
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError) {
            throw new DatabaseError(error.message);
          }

          throw error;
        }
      },
      [`getDocumentsByInsightIdSurveyIdQuestionId-${insightId}-${surveyId}-${questionId}-${limit}-${offset}`],
      {
        tags: [
          documentCache.tag.byInsightIdSurveyIdQuestionId(insightId, surveyId, questionId),
          insightCache.tag.byId(insightId),
        ],
      }
    )()
);

export const getDocumentById = reactCache(
  (documentId: string): Promise<TDocument | null> =>
    cache(
      async () => {
        validateInputs([documentId, ZId]);

        try {
          const document = await prisma.document.findUnique({
            where: {
              id: documentId,
            },
          });

          return document;
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError) {
            throw new DatabaseError(error.message);
          }

          throw error;
        }
      },
      [`getDocumentById-${documentId}`],
      {
        tags: [documentCache.tag.byId(documentId)],
      }
    )()
);

export const updateDocument = async (
  documentId: string,
  updates: Partial<TDocument>,
  environmentId: string,
  insightId?: string
): Promise<TDocument> => {
  validateInputs(
    [documentId, ZId],
    [updates, ZDocument.partial()],
    [environmentId, ZId],
    [insightId, ZId.optional()]
  );
  try {
    const updatedDocument = await prisma.$transaction(async (tx) => {
      const document = await tx.document.findFirst({
        where: {
          id: documentId,
          environment: {
            id: environmentId,
          },
        },
      });

      if (!document) {
        throw new Error("Document not found or access denied");
      }

      return tx.document.update({
        where: { id: documentId },
        data: updates,
      });
    });
    documentCache.revalidate({ environmentId: environmentId });
    if (insightId) {
      insightCache.revalidate({ id: insightId });
    }
    return updatedDocument;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      throw new DatabaseError(error.message);
    }

    throw error;
  }
};
