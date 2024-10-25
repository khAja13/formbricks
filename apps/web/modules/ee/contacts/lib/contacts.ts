import "server-only";
import { Prisma } from "@prisma/client";
import { cache as reactCache } from "react";
import { prisma } from "@formbricks/database";
import { cache } from "@formbricks/lib/cache";
import { ITEMS_PER_PAGE } from "@formbricks/lib/constants";
import { contactAttributeCache } from "@formbricks/lib/contactAttribute/cache";
import { getOrganizationIdFromEnvironmentId } from "@formbricks/lib/organization/utils";
import { validateInputs } from "@formbricks/lib/utils/validate";
import { ZId, ZOptionalNumber, ZOptionalString } from "@formbricks/types/common";
import { TContactAttributes } from "@formbricks/types/contact-attributes";
import { DatabaseError, ResourceNotFoundError, ValidationError } from "@formbricks/types/errors";
import {
  TContact,
  TContactWithAttributes,
  ZContactCSVAttributeMap,
  ZContactCSVDuplicateAction,
  ZContactCSVUploadResponse,
} from "../types/contact";
import { contactCache } from "./contactCache";
import { convertPrismaContactAttributes, transformPrismaContact } from "./utils";

const selectContact = {
  id: true,
  createdAt: true,
  updatedAt: true,
  environmentId: true,
  attributes: {
    select: {
      value: true,
      attributeKey: {
        select: {
          key: true,
          name: true,
        },
      },
    },
  },
} satisfies Prisma.ContactSelect;

const selectContactAttribute = {
  value: true,
  attributeKey: {
    select: {
      key: true,
      name: true,
    },
  },
} satisfies Prisma.ContactAttributeSelect;

const buildContactWhereClause = (environmentId: string, search?: string): Prisma.ContactWhereInput => {
  const whereClause: Prisma.ContactWhereInput = { environmentId };

  if (search) {
    whereClause.OR = [
      {
        attributes: {
          some: {
            value: {
              contains: search,
              mode: "insensitive",
            },
          },
        },
      },
      {
        id: {
          contains: search,
          mode: "insensitive",
        },
      },
    ];
  }

  return whereClause;
};

export const getContacts = reactCache(
  (environmentId: string, offset?: number, searchValue?: string): Promise<TContactWithAttributes[]> =>
    cache(
      async () => {
        validateInputs([environmentId, ZId], [offset, ZOptionalNumber], [searchValue, ZOptionalString]);

        try {
          const contacts = await prisma.contact.findMany({
            where: buildContactWhereClause(environmentId, searchValue),
            select: selectContact,
            take: ITEMS_PER_PAGE,
            skip: offset,
          });

          return contacts.map((contact) => transformPrismaContact(contact));
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError) {
            throw new DatabaseError(error.message);
          }

          throw error;
        }
      },
      [`getContacts-${environmentId}-${offset}-${searchValue ?? ""}`],
      {
        tags: [contactCache.tag.byEnvironmentId(environmentId)],
      }
    )()
);

export const getContact = reactCache(
  (contactId: string): Promise<TContact | null> =>
    cache(
      async () => {
        validateInputs([contactId, ZId]);

        try {
          return await prisma.contact.findUnique({
            where: {
              id: contactId,
            },
            select: selectContact,
          });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError) {
            throw new DatabaseError(error.message);
          }

          throw error;
        }
      },
      [`getContact-${contactId}`],
      {
        tags: [contactCache.tag.byId(contactId)],
      }
    )()
);

export const deleteContact = async (contactId: string): Promise<TContact | null> => {
  validateInputs([contactId, ZId]);

  try {
    const contact = await prisma.contact.delete({
      where: {
        id: contactId,
      },
      select: selectContact,
    });

    const userId = contact.attributes.find((attr) => attr.attributeKey.key === "userId")?.value;

    contactCache.revalidate({
      id: contact.id,
      userId,
      environmentId: contact.environmentId,
    });

    return contact;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      throw new DatabaseError(error.message);
    }

    throw error;
  }
};

export const getOrganizationIdFromContactId = async (contactId: string) => {
  const contact = await getContact(contactId);
  if (!contact) {
    throw new ResourceNotFoundError("contact", contactId);
  }

  return await getOrganizationIdFromEnvironmentId(contact.environmentId);
};

export const getContactAttributes = reactCache(
  (contactId: string): Promise<TContactAttributes> =>
    cache(
      async () => {
        validateInputs([contactId, ZId]);

        try {
          const prismaAttributes = await prisma.contactAttribute.findMany({
            where: {
              contactId,
            },
            select: selectContactAttribute,
          });

          return convertPrismaContactAttributes(prismaAttributes);
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError) {
            throw new DatabaseError(error.message);
          }

          throw error;
        }
      },
      [`getContactAttributes-${contactId}`],
      {
        tags: [contactAttributeCache.tag.byContactId(contactId)],
      }
    )()
);

export const createContactsFromCSV = async (
  csvData: Record<string, string>[],
  environmentId: string,
  duplicateContactsAction: "skip" | "update" | "overwrite",
  attributeMap: Record<string, string>
): Promise<TContact[]> => {
  const startTime = Date.now();

  validateInputs(
    [csvData, ZContactCSVUploadResponse],
    [environmentId, ZId],
    [duplicateContactsAction, ZContactCSVDuplicateAction],
    [attributeMap, ZContactCSVAttributeMap]
  );

  try {
    // Extract unique emails and userIds from CSV data
    const csvEmails = Array.from(new Set(csvData.map((r) => r.email).filter(Boolean)));
    const csvUserIds = Array.from(new Set(csvData.map((r) => r.userId).filter(Boolean)));

    // Fetch existing contacts by email
    const existingContactsByEmail = await prisma.contact.findMany({
      where: {
        environmentId,
        attributes: {
          some: {
            attributeKey: {
              key: "email",
            },
            value: {
              in: csvEmails,
            },
          },
        },
      },
      select: {
        id: true,
        attributes: {
          select: {
            attributeKey: { select: { key: true, id: true } },
            value: true,
          },
        },
      },
    });

    // Map emails to existing contacts
    const emailToContactMap = new Map<string, TContact>();
    existingContactsByEmail.forEach((contact) => {
      const emailAttr = contact.attributes.find((attr) => attr.attributeKey.key === "email");
      if (emailAttr) {
        emailToContactMap.set(emailAttr.value, contact);
      }
    });

    // Check for duplicate userIds
    if (csvUserIds.length > 0) {
      const existingUserIds = await prisma.contactAttribute.findMany({
        where: {
          attributeKey: {
            key: "userId",
            environmentId,
          },
          value: {
            in: csvUserIds,
          },
        },
        select: { value: true },
      });

      if (existingUserIds.length > 0) {
        throw new ValidationError(
          `Contact with userId ${existingUserIds[0].value} already exist for this environment`
        );
      }
    }

    // Fetch existing attribute keys and cache them
    const existingAttributeKeys = await prisma.contactAttributeKey.findMany({
      where: { environmentId },
      select: { key: true, id: true },
    });

    const attributeKeyMap = new Map<string, string>();
    existingAttributeKeys.forEach((attrKey) => {
      attributeKeyMap.set(attrKey.key, attrKey.id);
    });

    // Identify missing attribute keys
    const csvKeys = new Set<string>();
    csvData.forEach((record) => {
      Object.keys(record).forEach((key) => csvKeys.add(key));
    });

    const missingKeys = Array.from(csvKeys).filter((key) => !attributeKeyMap.has(key));

    // Create missing attribute keys
    if (missingKeys.length > 0) {
      await prisma.contactAttributeKey.createMany({
        data: missingKeys.map((key) => ({
          key,
          name: key,
          environmentId,
        })),
        skipDuplicates: true,
      });

      // Fetch and update the attributeKeyMap with new keys
      const newAttributeKeys = await prisma.contactAttributeKey.findMany({
        where: {
          key: { in: missingKeys },
          environmentId,
        },
        select: { key: true, id: true },
      });

      newAttributeKeys.forEach((attrKey) => {
        attributeKeyMap.set(attrKey.key, attrKey.id);
      });
    }

    const createdContacts: TContact[] = [];

    // Process contacts in parallel
    const contactPromises = csvData.map(async (record) => {
      // Skip records without email
      if (!record.email) return null;

      const existingContact = emailToContactMap.get(record.email);

      if (existingContact) {
        // Handle duplicates based on duplicateContactsAction
        switch (duplicateContactsAction) {
          case "skip":
            return null;

          case "update": {
            const existingAttributes = new Map<string, string>();
            existingContact.attributes.forEach((attr) => {
              existingAttributes.set(attr.attributeKey.key, attr.value);
            });

            const attributesToUpsert = Object.entries(record).map(([key, value]) => ({
              where: {
                contactId_attributeKeyId: {
                  contactId: existingContact.id,
                  attributeKeyId: attributeKeyMap.get(key),
                },
              },
              update: { value },
              create: {
                attributeKeyId: attributeKeyMap.get(key),
                value,
              },
            }));

            // Update contact with upserted attributes
            const updatedContact = await prisma.contact.update({
              where: { id: existingContact.id },
              data: {
                attributes: {
                  upsert: attributesToUpsert,
                },
              },
              include: {
                attributes: {
                  select: {
                    attributeKey: { select: { key: true } },
                    value: true,
                  },
                },
              },
            });

            return updatedContact;
          }

          case "overwrite": {
            // Overwrite by deleting existing attributes and creating new ones
            await prisma.contactAttribute.deleteMany({
              where: { contactId: existingContact.id },
            });

            const newAttributes = Object.entries(record).map(([key, value]) => ({
              attributeKeyId: attributeKeyMap.get(key),
              value,
            }));

            const updatedContact = await prisma.contact.update({
              where: { id: existingContact.id },
              data: {
                attributes: {
                  create: newAttributes,
                },
              },
              include: {
                attributes: {
                  select: {
                    attributeKey: { select: { key: true } },
                    value: true,
                  },
                },
              },
            });

            return updatedContact;
          }
        }
      } else {
        // Create new contact
        const newAttributes = Object.entries(record).map(([key, value]) => ({
          attributeKeyId: attributeKeyMap.get(key),
          value,
        }));

        const newContact = await prisma.contact.create({
          data: {
            environmentId,
            attributes: {
              create: newAttributes,
            },
          },
          include: {
            attributes: {
              select: {
                attributeKey: { select: { key: true } },
                value: true,
              },
            },
          },
        });

        return newContact;
      }
    });

    const results = await Promise.all(contactPromises);
    createdContacts.push(...results.filter((contact) => contact !== null));

    console.log(`createContactsFromCSV took ${Date.now() - startTime}ms`);

    return createdContacts;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      throw new DatabaseError(error.message);
    }
    throw error;
  }
};